# xangi-google-tasks

[日本語](README.md)

An Even Realities G2 app for viewing and editing Google Tasks, plus the xangi Managed Extension it connects to.

- Browse task lists and tasks (due dates, overdue `!`, indented subtasks)
- Mark tasks completed / not completed
- Change due dates (none, today to +30 days; dates only, as the Tasks API ignores times)
- Delete tasks (with confirmation)
- Hold the ring and speak to add a task (release to confirm)
- Toggle completed tasks from the last 30 days

Titles and notes are edited in the official Google Tasks app.

Gestures: scroll = select, tap = open/confirm, double tap = back (exit on the list screen), long press on the task screen = add by voice.

The G2 app calls `http://<xangi-host>:18888/api/devices/xangi-google-tasks/*`; xangi forwards to `server/runtime.py`, which uses the `gog` CLI for Google Tasks and Groq Whisper for speech-to-text. Google OAuth tokens stay in the host's gog keyring.

See [XANGI_SETUP.md](XANGI_SETUP.md) (Japanese) for setup. Tests: `cd server && python3 -m unittest`, `cd g2 && npm test`.
