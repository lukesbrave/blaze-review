import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, readdir, utimes, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const source = await readFile(new URL('./plugin.js', import.meta.url), 'utf8');
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const helperSource = await readFile(new URL('./helper.py', import.meta.url), 'utf8');

// Buzz's spawn: declared args, then the caller's.
function fakeHost(program = 'python3') {
  const spawned = [];
  return {
    spawned,
    async spawn(id, { args = [], onStdout, onStderr } = {}) {
      const declared = manifest.host.processes.find(p => p.id === id);
      assert.ok(declared, `Process ${id} is not declared`);
      const child = spawn(program, [...declared.args, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      spawned.push(child);
      child.stdout.setEncoding('utf8').on('data', d => onStdout?.(d));
      child.stderr.setEncoding('utf8').on('data', d => onStderr?.(d));
      const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
      return {
        write: data => new Promise((resolve, reject) => child.stdin.write(data, e => (e ? reject(e) : resolve()))),
        end: (data = '') => new Promise(resolve => child.stdin.end(data, resolve)),
        kill: async () => { child.kill('SIGTERM'); },
        exited,
      };
    },
  };
}

// Stands in for `hyperframes preview`: serves /api/projects naming the project folder, records its pid.
const FAKE_STUDIO = `
import http.server, json, os, subprocess, sys
args = sys.argv[1:]; port = int(args[args.index("--port") + 1]); folder = args[-1]
open(os.path.join(folder, ".studio-pid"), "w").write(str(os.getpid()))
# Like Studio's headless Chrome: a child in its own session, out of the helper's process group.
chrome = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"], start_new_session=True)
open(os.path.join(folder, ".chrome-pid"), "w").write(str(chrome.pid))
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"projects": [{"id": os.path.basename(folder)}]}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
`;

async function workingFiles() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'blaze-review-')));
  const project = async (path, extra = {}) => {
    await mkdir(join(root, path, 'compositions'), { recursive: true });
    await mkdir(join(root, path, 'assets', 'footage'), { recursive: true });
    await writeFile(join(root, path, 'hyperframes.json'), '{}');
    await writeFile(join(root, path, 'index.html'), '<div data-composition-src="compositions/a.html"></div>');
    await writeFile(join(root, path, 'compositions', 'a.html'), '<div>title</div>');
    await writeFile(join(root, path, 'assets', 'footage', 'shot.mov'), Buffer.alloc(4096, 7));
    for (const [name, body] of Object.entries(extra)) { await mkdir(join(root, path, name, '..'), { recursive: true }); await writeFile(join(root, path, name), body); }
  };
  await project('Trailer/hf', { 'renders/trailer-v4.mp4': 'big', '.hyperframes/video-state.json': '{}', '.transcode-cache/proxy.mp4': 'proxy', 'edit.json': '{}' });
  await project('Sales page preview');
  await project('Trailer/overlays/capitalism');
  await mkdir(join(root, 'Trailer', 'analysis'), { recursive: true });
  await mkdir(join(root, '.cache', 'stray'), { recursive: true });
  await writeFile(join(root, '.cache', 'stray', 'hyperframes.json'), '{}');
  await writeFile(join(root, '.cache', 'stray', 'index.html'), '');
  await writeFile(join(root, 'fake_studio.py'), FAKE_STUDIO);
  return root;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test('manifest declares only the helper process and the page registers without starting it', () => {
  assert.equal(manifest.id, 'bravebrand.blaze-review');
  assert.equal(manifest.apiVersion, 1);
  assert.ok(Buffer.byteLength(manifest.description) <= 280);
  assert.deepEqual(Object.keys(manifest.host), ['processes']);
  assert.deepEqual(manifest.host.processes, [{ id: 'helper', program: 'python3', args: ['-I', '-c'] }]);
  assert.deepEqual(module.inject, ['react', 'pages', 'host', 'relay', 'agents', 'navigation', 'browser']);
  assert.ok(source.includes(`const HELPER_SOURCE = ${JSON.stringify(helperSource)};`));
  const host = fakeHost();
  let page;
  module.apply({ react: { createElement: () => null }, host, pages: { register(value) { page = value; } }, relay: {}, agents: {}, navigation: {}, browser: {} });
  assert.equal(page.id, 'review');
  assert.equal(page.title, 'Blaze Review');
  assert.equal(page.primary, true);
  assert.equal(page.placement, 'topbar');
  assert.equal(host.spawned.length, 0);
});

test('messages name the project and ask for an edit.json change, or give the go-ahead', () => {
  const job = { label: 'Trailer', source: '/Volumes/Expansion/BraveBrand Event Edit/Working files/Trailer/hf', copy: { copiedAt: 1793055660 } };
  const notes = module.blazeMessage('notes', job, '  ## HyperFrames element edit request v1\nPlayback time: 0:49.36\nTrim three frames.  ');
  const lines = notes.split('\n');
  assert.equal(lines[0], 'Review notes on the Trailer edit.');
  assert.match(lines[1], /^Project: \/Volumes\/Expansion\/BraveBrand Event Edit\/Working files\/Trailer\/hf \(reviewed in HyperFrames Studio on a copy made .+\)\. Times are the composition's playback time; .*Change edit\.json and rebuild/);
  assert.deepEqual(lines.slice(2), ['', '## HyperFrames element edit request v1', 'Playback time: 0:49.36', 'Trim three frames.']);
  assert.match(module.blazeMessage('approve', job, ''), /^Approved: the Trailer edit as built in \/Volumes\/.*\/Trailer\/hf \(reviewed in HyperFrames Studio on a copy made .+\)\. Go ahead with the final render\.$/);
  assert.match(module.blazeMessage('approve', job, 'Keep the music low.'), /final render\.\n\nKeep the music low\.$/);
});

test('Blaze is found by name and owner, conversations rank DMs first, mentions use NIP-19', () => {
  const blaze = { name: 'Blaze (Video Editor & Ads Manager)', pubkey: '4e7a01cbde98601da732b3c051a95274e311c24a275695ced0907ab46ccbd9ff', owner: 'luke' };
  const agents = module.blazeAgents([{ name: 'Bob (Content Manager)', pubkey: 'b'.repeat(64), owner: 'luke' }, { name: 'Blaze — Hub Test', pubkey: 'c'.repeat(64), owner: 'luke' }, blaze, { name: 'Blaze', pubkey: 'd'.repeat(64), owner: 'someone else' }], 'luke');
  assert.deepEqual(agents.map(a => a.pubkey), [blaze.pubkey, 'c'.repeat(64)]);
  const channels = [
    { id: 'room', name: 'bali-edit', channelType: 'stream', members: [blaze.pubkey, 'luke'], lastActivityAt: 30 },
    { id: 'dm', name: 'dm', channelType: 'dm', participants: [blaze.pubkey], lastActivityAt: 10 },
    { id: 'old', name: 'gone', channelType: 'stream', members: [blaze.pubkey], archived: true },
    { id: 'other', name: 'general', channelType: 'stream', members: ['luke'] },
  ];
  assert.deepEqual(module.blazeConversations(channels, [blaze]).map(c => c.channel.id), ['dm', 'room']);
  assert.equal(module.shortName(blaze.name), 'Blaze');
  assert.equal(module.npubEncode('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'), 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6');
});

for (const python of ['python3', '/usr/bin/python3']) {
  test(`helper finds jobs, opens Studio on a cloned review copy, notices rebuilds and logs notes (${python})`, async () => {
    const root = await workingFiles();
    const host = fakeHost(python);
    const helper = module.createHelper(host, { source: helperSource, root, extra: [JSON.stringify([python, join(root, 'fake_studio.py')])], timeoutMs: 20000 });
    try {
      assert.equal((await helper.ensure()).connected, true);
      const { jobs } = await helper.request('jobs');
      assert.deepEqual(jobs.map(j => [j.job, j.label, j.copy]), [['Sales page preview', 'Sales page preview', null], ['Trailer/hf', 'Trailer', null], ['Trailer/overlays/capitalism', 'Trailer · overlays/capitalism', null]]);

      const opened = await helper.request('open', { job: 'Trailer/hf' });
      const copy = join(homedir(), 'Library', 'Caches', 'BlazeReview', createHash('sha256').update(root).digest('hex').slice(0,20), 'trailer');
      assert.equal(opened.copyPath, copy);
      assert.equal(opened.label, 'Trailer');
      assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/#project\/trailer$/);
      assert.equal(opened.copy.stale, false);
      assert.deepEqual(await (await fetch(opened.url.replace('/#project/trailer', '/api/projects'))).json(), { projects: [{ id: 'trailer' }] });
      assert.deepEqual((await readdir(copy)).sort(), ['.blaze-review-copy', '.chrome-pid', '.studio-pid', '.transcode-cache', 'assets', 'compositions', 'edit.json', 'hyperframes.json', 'index.html']);
      assert.deepEqual(await readFile(join(copy, 'assets', 'footage', 'shot.mov')), Buffer.alloc(4096, 7));
      assert.equal(existsSync(join(root, 'Trailer', 'hf', 'renders', 'trailer-v4.mp4')), true);
      const firstStudio = Number(await readFile(join(copy, '.studio-pid'), 'utf8'));
      assert.equal(alive(firstStudio), true);
      assert.equal((await helper.request('status')).studio, 'Trailer/hf');

      // Studio stamps the copy, never the project.
      await writeFile(join(copy, 'compositions', 'a.html'), '<div data-hf-id="hf-1">title</div>');
      assert.equal(await readFile(join(root, 'Trailer', 'hf', 'compositions', 'a.html'), 'utf8'), '<div>title</div>');

      assert.equal((await helper.request('check', { job: 'Trailer/hf' })).copy.stale, false);
      const later = new Date(Date.now() + 10000);
      await utimes(join(root, 'Trailer', 'hf', 'index.html'), later, later);
      assert.equal((await helper.request('check', { job: 'Trailer/hf' })).copy.stale, true);
      assert.equal((await helper.request('open', { job: 'Trailer/hf' })).copy.stale, true, 'opening keeps the copy Luke was reviewing');

      const refreshed = await helper.request('refresh', { job: 'Trailer/hf' });
      assert.equal(refreshed.copy.stale, false);
      assert.equal(await readFile(join(copy, 'compositions', 'a.html'), 'utf8'), '<div>title</div>');
      await settle(200);
      assert.equal(alive(firstStudio), false);

      await helper.request('open', { job: 'Sales page preview' });
      const salesStudio = Number(await readFile(join(homedir(), 'Library', 'Caches', 'BlazeReview', createHash('sha256').update(root).digest('hex').slice(0,20), 'sales-page-preview', '.studio-pid'), 'utf8'));
      await settle(200);
      assert.equal(alive(Number(await readFile(join(copy, '.studio-pid'), 'utf8'))), false, 'one Studio at a time');
      assert.equal(alive(salesStudio), true);

      await helper.request('log', { job: 'Trailer/hf', entry: { kind: 'notes', text: 'Trim three frames.' } });
      const logged = await helper.request('log', { job: 'Trailer/hf', entry: { kind: 'approve', text: '' } });
      assert.equal(logged.count, 2);
      const log = JSON.parse(await readFile(join(root, 'Trailer', 'hf', 'review-notes.json'), 'utf8'));
      assert.equal(log.format, 'bravebrand.blaze-review/2');
      assert.equal(log.job, 'Trailer');
      assert.deepEqual(log.notes.map(n => n.kind), ['notes', 'approve']);
      await writeFile(join(root, 'Sales page preview', 'review-notes.json'), '[]');
      await assert.rejects(helper.request('log', { job: 'Sales page preview', entry: {} }), /not in the Blaze Review format/);

      await assert.rejects(helper.request('open', { job: '../' }), /Outside the Working files folder/);
      await assert.rejects(helper.request('open', { job: 'Trailer' }), /Not a HyperFrames project/);
      await assert.rejects(helper.request('open', { job: '.cache/stray/../../../' }), /Outside the Working files folder/);
      await assert.rejects(helper.request('nope'), /Unknown request/);

      const salesChrome = Number(await readFile(join(homedir(), 'Library', 'Caches', 'BlazeReview', createHash('sha256').update(root).digest('hex').slice(0,20), 'sales-page-preview', '.chrome-pid'), 'utf8'));
      assert.equal(alive(salesChrome), true);
      await helper.request('stop');
      await settle(200);
      assert.equal(alive(salesStudio), false);
      assert.equal(alive(salesChrome), false, "Studio's Chrome stops too");

      await helper.request('open', { job: 'Trailer/overlays/capitalism' });
      const overlay = join(homedir(), 'Library', 'Caches', 'BlazeReview', createHash('sha256').update(root).digest('hex').slice(0,20), 'trailer-overlays-capitalism');
      const lastStudio = Number(await readFile(join(overlay, '.studio-pid'), 'utf8'));
      const lastChrome = Number(await readFile(join(overlay, '.chrome-pid'), 'utf8'));
      host.spawned[0].kill('SIGTERM'); // what Buzz sends when it unloads the plugin
      await new Promise(resolve => host.spawned[0].on('exit', resolve));
      await settle(200);
      assert.equal(alive(lastStudio), false, 'Studio stops with the helper');
      assert.equal(alive(lastChrome), false, "Studio's Chrome stops with the helper");
    } finally {
      helper.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a Studio that cannot start is reported with its log, and a missing drive is not a crash', async () => {
  const root = await workingFiles();
  const host = fakeHost();
  const helper = module.createHelper(host, { source: helperSource, root, extra: [JSON.stringify(['python3', '-c', 'import sys; print("boom"); sys.exit(3)'])] });
  try {
    await assert.rejects(helper.request('open', { job: 'Trailer/hf' }), /stopped while starting; see .*trailer\.studio\.log/);
    assert.match(await readFile(join(homedir(), 'Library', 'Caches', 'BlazeReview', createHash('sha256').update(root).digest('hex').slice(0,20), 'trailer.studio.log'), 'utf8'), /boom/);
  } finally { helper.stop(); await rm(root, { recursive: true, force: true }); }

  const missing = module.createHelper(fakeHost(), { source: helperSource, root: '/Volumes/Not Connected/Working files', timeoutMs: 5000 });
  assert.equal((await missing.ensure()).connected, false);
  await assert.rejects(missing.request('jobs'), /project folder is unavailable/);
  missing.stop();
});

 test('fresh setup accepts a custom folder and a project selected directly', async () => {
  const root = await workingFiles(); const helper = module.createHelper(fakeHost(), { source: helperSource, root: '' });
  try {
    assert.equal((await helper.ensure()).connected, false);
    await assert.rejects(helper.request('configure', {root: '/no/such/blaze-folder'}), /Folder not found/);
    assert.equal((await helper.request('configure', {root})).connected, true);
    assert.equal((await helper.request('jobs')).jobs.length, 3);
    await helper.request('configure', {root: join(root, 'Trailer', 'hf')});
    assert.deepEqual((await helper.request('jobs')).jobs.map(j => j.job), ['.']);
  } finally { helper.stop(); await rm(root, {recursive:true,force:true}); }
});
