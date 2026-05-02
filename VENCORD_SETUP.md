# Vencord Setup Reference

Quick reference for common Vencord tasks. For first-time setup, see [readme.md](readme.md).

---

## Commands (run inside your Vencord folder)

| Task | Command |
|---|---|
| Build after adding or updating a plugin | `pnpm build` |
| Re-inject after a Discord update | `pnpm inject` |
| Update Vencord itself | `git pull` → `pnpm install` → `pnpm build` |

You only need to run `pnpm inject` once when first setting up, and again whenever Discord auto-updates and removes Vencord.

---

## Finding your Vencord folder

If you put it on your Desktop:
```
%USERPROFILE%\Desktop\Vencord
```

The `userplugins` folder is at:
```
Vencord\src\userplugins\
```

You can open it directly: press `Win + R`, type the path above, press Enter.

---

## Common issues

**`pnpm` not recognized** — Close your terminal, open a new one. If still broken, restart your computer.

**`pnpm build` fails** — Run `pnpm install` first, then try again.

**`pnpm inject` says no Discord found** — Fully close Discord (right-click the tray icon → Quit), then try again.

**No Vencord section in Discord Settings** — Run `pnpm inject` again. Discord may have auto-updated.

**Plugin not appearing in the plugin list** — Make sure the folder is named exactly `MusicControl` inside `userplugins`, and that you ran `pnpm build` after copying it.
