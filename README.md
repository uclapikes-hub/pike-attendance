# PIKE Attendance Tracker

Real-time event check-in and attendance tracking for the chapter, hosted on **GitHub Pages** with **Firebase** as the database.

## What it does

- Brothers scan a per-event QR code (or visit the link) and check in by typing their name
- Exec creates events, manages the roster, and pulls Excel/CSV reports from any device
- Everything syncs in real time across all devices — the president and the recruitment chair see each other's changes instantly
- Roster, events, and check-ins all live in Firestore — secure, backed up automatically, and free at chapter scale

## Stack

| Piece | Tool | Cost |
|------|------|------|
| Hosting | GitHub Pages | Free |
| Database | Firebase Firestore | Free for our usage |
| Auth | Firebase Auth (Google sign-in) | Free |
| Exec access | Email allowlist in Firestore rules | — |

## Quick start

**Read [SETUP.md](SETUP.md) for the full walkthrough.** It takes about 30 minutes the first time and covers:

1. Creating a Firebase project (free)
2. Enabling Google sign-in and Firestore
3. Pasting your config keys into `js/firebase-config.js`
4. Adding exec emails to the security rules
5. Pushing to GitHub and turning on Pages
6. Running the one-time roster seeder

## Files in this repo

```
index.html              ← Main check-in page (what brothers use)
seed-roster.html        ← One-time roster seeder (exec runs once)
seed-roster.csv         ← Initial chapter roster (imported during setup)

js/
  firebase-config.js    ← YOU EDIT THIS (paste your Firebase config)
  data.js               ← Firestore wrapper (don't edit)
  app.js                ← UI logic (don't edit)

assets/
  styles.css            ← PIKE brand styling
  pike-wordmark.png     ← Logo (transparent)
  coat-of-arms.jpg      ← Crest

firestore.rules         ← YOU EDIT THIS (paste exec emails into the allowlist)
SETUP.md                ← Full setup walkthrough
```

## Day-to-day use

**Brothers:** Visit the URL → pick the event → type your name → check in.

**Exec at events:** Open the Events tab → click QR next to the event → display the QR on a phone or print it. Brothers scan it and they're auto-routed to the right event.

**Exec for reports:** Attendance tab → Export Excel for a four-sheet workbook (per-check-in, per-brother, per-event, summary).

**Exec for roster maintenance:** Roster tab → Add Brother form for one-offs, or Import Roster for bulk updates from CSV/Excel.

## Need to add more exec officers?

Edit `firestore.rules`, add their `@gmail.com` (or whatever they use to sign in with Google) to the email allowlist, then in the Firebase console go to **Firestore → Rules** and paste the updated file in. Takes 10 seconds.

## Questions?

Re-read SETUP.md, or ask whoever set this up originally to walk you through it. Most issues come from forgetting to add a new exec email to the allowlist.
