# File Tidy

A small Windows desktop app for cleaning up a folder that's already a mess — Downloads, Desktop, wherever loose files pile up. Pick a folder, review the plan, and let File Tidy sort everything into `Images`, `Documents`, `Archives`, and the rest of the usual categories. Nothing moves until you say so, and the last run can always be undone.

Built with TypeScript, Electron, and Material UI.

> **Don't want to install anything?**
> If you just want new downloads sorted automatically as they land, check out the companion browser extension instead — it does that job with zero install footprint:
> **[Download Organizer for Chrome / Edge](https://chromewebstore.google.com/detail/download-organizer/cokdfcghhpfmojndoolcckdpelmjjkho)**
>
> File Tidy is for the opposite problem: files that are *already* sitting in a folder and need a one-time (or occasional) cleanup. The two tools share the same category system, so file types are grouped the same way in both.

## What it does

1. Choose one folder.
2. Review every proposed move before anything actually happens.
3. Move matching files into their category folders — Images, Documents, Archives, and so on.
4. Undo the last run, as long as the moved files haven't been touched since.

## Categories

Same defaults as the browser extension: **Images, Videos, Audio, Documents, Spreadsheets, Presentations, Archives, Applications, Code,** and **Others**.

Open **Folders & file types** above the folder picker to:
- Rename any destination folder
- Edit the comma-separated extensions for a category
- Pause a category so it's skipped entirely
- Add your own custom category

A file type can only belong to one active category at a time. Hit **Save changes** to keep your rules for next time, or **Cancel** to discard edits. If you change the rules, re-scan the folder to see an updated plan before running anything.

## Why it's safe to run

File Tidy is built to be boring and predictable, which is exactly what you want from something that moves your files around:

- **Fully local.** No account, no analytics, no uploads, and it never looks inside your files — only names and extensions matter.
- **Stays inside the folder you chose.** Category folders are created *inside* the folder you pick to organize, even if your browser's download location is somewhere else.
- **Top-level only.** Only loose files sitting directly in the folder are touched. Existing subfolders are left alone — recursive sorting isn't part of version 1.
- **Never overwrites a file.** Moves happen as a same-volume, no-replace operation. If a drive can't support that safely, File Tidy skips it rather than quietly falling back to copy-and-delete.
- **Leaves what it doesn't recognize.** Unknown files stay put by default — you can opt in to routing them to `Others` instead.
- **Won't silently rename over a duplicate.** If a destination name is already taken, the file is left alone unless you turn on "Keep both," which appends something like `report (1).pdf`.
- **Skips the risky stuff.** Hidden/system files, shortcuts, incomplete downloads, symlinks, and junctions are all left alone.
- **Journals before it moves anything.** Every mutation is preceded by a versioned, write-ahead local record. If that record is ever incomplete or unreadable, File Tidy blocks new runs until it's resolved, instead of just overwriting it.
- **Undo is identity-based, not guesswork.** File Tidy tracks a stable filesystem identity along with precise timestamps and size, and only undoes a move if that identity still matches and the original spot is free.
- **When in doubt, it stops and asks for review.** If a move gets interrupted or File Tidy can't be sure which path it actually owns, it keeps both paths around and flags the item for manual review instead of guessing and possibly deleting something it shouldn't.
- **One honest limitation:** File Tidy doesn't hash file contents. That means normal renames, replacements, and edits are handled safely — but a file edited in place while keeping the exact same identity and metadata is an edge case that needs a human to check it, not the app.

## Running it locally

Install a current Node.js LTS release, then:

```powershell
pnpm install
pnpm start
```

Run the safety test suite:

```powershell
pnpm test
```

Run strict type checks:

```powershell
pnpm typecheck
```

## Building a portable Windows app

```powershell
pnpm install
pnpm dist:win
```

This produces a portable `.exe` in `dist/`. Copy it to any Windows machine — no Node.js or Python required to run it. The first build is unsigned, so Windows SmartScreen may flag it until it's code-signed.

`build-windows.ps1` runs the same portable build using the bundled Codex Node runtime, when available.

