# Blaze Review for Buzz — 0.3.0 (Mac)

Review Blaze's HyperFrames video projects in Buzz, send clip-specific changes to Blaze, and approve the final render.

## Install

In Buzz, open Settings → Plugins → Manage plugins → Add, choose the Git repository option and paste:

https://github.com/lukesbrave/blaze-review

Leave the branch blank. Select the plugin at the repository root. Accept its declared Python helper permission. Open **Blaze Review** in the top bar.

Requires Mac, current Buzz with host-process and browser support, Python 3 and Node.js/npm available to Buzz. First preview downloads the pinned HyperFrames 0.8.188 package using npx and needs internet access. Blaze must already be hired and have a conversation with you. This plugin does not hire an employee.

## Your footage and project folder

Enter the full local path to the folder where Blaze saves your editing projects, then press **Open folder**. You can select one HyperFrames project directly, or a parent folder containing several projects (discovered up to four levels deep). The folder is remembered on this Mac.

Projects can live on your Mac, an attached external drive, a mounted network share, or a Google Drive/Dropbox/iCloud folder downloaded to your Mac. Keep the drive mounted and mark cloud files available offline. A private cloud sharing URL is not a local folder: download or sync the files first, or ask Blaze to retrieve them through an authorised connection and prepare a local project. This plugin has no cloud account connector.

Ask Blaze: “Create a HyperFrames editing project from my footage in this folder. Keep media references inside the project or use working accessible URLs, and give me the project folder path for Blaze Review.” Raw footage alone is not an editing project; the folder must contain hyperframes.json and index.html. Project-relative media must be included; references outside the project need relinking by Blaze. Missing, expired or unauthorised remote media URLs will not be repaired automatically.

Review copies are stored in ~/Library/Caches/BlazeReview, separately for each selected folder. They copy project media and require sufficient free space; large footage takes time. Originals are preserved. Symlink targets are copied rather than edited in place. Read-only source folders can be reviewed, but saving review-notes.json there will fail and the interface reports that after sending.

## Request changes

Choose a job. In Studio, select a clip, press ⌘K, describe the change and copy the prompt. Paste it into **Send to Blaze**, choose the conversation and press **Send notes to Blaze**. You can also type timecoded notes directly. Messages send as you only when you press a send button.

Studio changes affect the review copy. Send instructions to Blaze so it updates the actual editing project. After Blaze rebuilds, press **Refresh copy**. Refresh replaces local review-copy changes. Press **Approve: render it** when satisfied; Blaze receives approval to render the project.

## Development and verification

Edit plugin.template.js and helper.py, then run `node build.mjs`. The generated plugin.js embeds the helper. Run `node --test contract.test.mjs`.

Tests exercise actual Python helpers with a stand-in preview server, custom-folder setup, direct project selection, source preservation, stale-copy detection, process shutdown and message formatting. They do not constitute a client-account/native Buzz or real HyperFrames playback test. Windows is not supported by this release.
