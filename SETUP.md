# Setup Walkthrough

This takes about 30 minutes the first time. You only do it once.

## What you'll need

- A Google account for the chapter (e.g. `pike.executive@gmail.com`) — this becomes the Firebase project owner
- Email addresses for exec officers who should be able to manage events/roster
- Permission to push to a GitHub repo (or create one)

---

## Part 1 — Create the Firebase project (~10 min)

### 1.1 Go to the Firebase console

Open https://console.firebase.google.com and sign in with the chapter Google account.

### 1.2 Create a new project

Click **"Add project"** → name it `pike-attendance` (or anything) → disable Google Analytics when asked (we don't need it) → click Create.

Wait ~30 seconds for it to finish provisioning.

### 1.3 Enable Google sign-in

Left sidebar → **Build → Authentication** → **Get started** → **Sign-in method** tab → click **Google** → toggle **Enable** → set the project's support email (your chapter Gmail) → **Save**.

### 1.4 Create the Firestore database

Left sidebar → **Build → Firestore Database** → **Create database** → start in **Production mode** (NOT test mode) → pick a location near you (e.g. `us-east1`) → click Enable.

You'll land on an empty database. Good.

### 1.5 Get your config keys

Click the gear icon next to "Project Overview" (top left) → **Project settings** → scroll down to **Your apps** → click the `</>` (web) icon to register a web app.

- App nickname: `pike-attendance`
- Do NOT check "Also set up Firebase Hosting"
- Click **Register app**

It'll show you a code block. You only need the `firebaseConfig` object — copy those values. They look like:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "pike-attendance.firebaseapp.com",
  projectId: "pike-attendance",
  storageBucket: "pike-attendance.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:123:web:abc..."
};
```

> **About these "API keys":** They are safe to put in public code. Google designs them to be public. Real security is enforced by the Firestore rules, which restrict writes to your exec email allowlist.

---

## Part 2 — Configure the repo (~5 min)

### 2.1 Paste your Firebase config

Open `js/firebase-config.js` and replace the placeholder values with the ones you copied:

```js
export const firebaseConfig = {
  apiKey:            "AIzaSy...",       // <- yours
  authDomain:        "pike-attendance.firebaseapp.com",
  projectId:         "pike-attendance",
  storageBucket:     "pike-attendance.appspot.com",
  messagingSenderId: "1234567890",
  appId:             "1:123:web:abc..."
};
```

Save the file.

### 2.2 Add exec emails to the security rules

Open `firestore.rules` and find the `isExec()` function near the top:

```js
function isExec() {
  return request.auth != null
      && request.auth.token.email in [
           'president@yourchapter.org',
           'vp@yourchapter.org',
           // ...
         ];
}
```

Replace the placeholder emails with the actual Gmail addresses (or whatever Google-sign-in-capable addresses) of your exec officers. **Use the emails they will sign in with.** A typical setup:

```js
in [
  'pike.president.uva@gmail.com',
  'pike.vp.uva@gmail.com',
  'pike.recruitment.uva@gmail.com',
  'pike.treasurer.uva@gmail.com',
  'pike.executive@gmail.com'  // master account for safety
]
```

Save the file.

### 2.3 Upload the rules to Firebase

Back in the Firebase console: **Build → Firestore Database → Rules** tab → delete what's there → paste the entire contents of `firestore.rules` → click **Publish**.

You should see "Rules updated" at the bottom.

---

## Part 3 — Deploy to GitHub Pages (~5 min)

### 3.1 Push the repo to GitHub

If you haven't already:

```bash
cd path/to/pike-attendance
git init
git add .
git commit -m "Initial PIKE attendance app"
git branch -M main
git remote add origin https://github.com/YOUR-CHAPTER/pike-attendance.git
git push -u origin main
```

(Or use GitHub Desktop / VS Code's git UI — same thing.)

### 3.2 Turn on GitHub Pages

In the GitHub repo: **Settings → Pages** (left sidebar) → under **Source**, pick **Deploy from a branch** → branch: `main`, folder: `/ (root)` → **Save**.

Wait ~1 minute. GitHub will show "Your site is live at `https://YOUR-CHAPTER.github.io/pike-attendance/`" — this is the URL you'll share with the chapter.

### 3.3 Authorize the GitHub Pages domain in Firebase

This one trips people up. Firebase needs to know your URL is allowed to use auth.

Firebase console → **Build → Authentication → Settings** tab → **Authorized domains** → **Add domain** → paste `YOUR-CHAPTER.github.io` (just the domain, no `https://` and no path) → Save.

---

## Part 4 — Seed the roster (~3 min)

Visit `https://YOUR-CHAPTER.github.io/pike-attendance/seed-roster.html` (the seeder page).

1. Click **Exec Sign In** (top right). Google popup appears. Sign in with one of the exec emails you added to the rules.
2. Click **Choose File** and pick `seed-roster.csv` from this repo (it's the chapter roster you already had).
3. Confirm the count looks right.
4. Click **Push to Firestore**.

Done. Open the main app at `https://YOUR-CHAPTER.github.io/pike-attendance/` — the roster should show up populated. You can ignore `seed-roster.html` from here on; future roster updates happen in the regular Roster tab.

---

## Part 5 — Test it (~2 min)

1. Open the main app on your laptop. You should see the roster populated.
2. Sign in as exec → create a test event ("Test Event", any date).
3. In a private/incognito window, open the same URL — you should see the event without signing in. Pick yourself from the roster, hit Check In.
4. Back in the regular window, the Attendance tab should show your check-in (in real time, no refresh needed).
5. Delete the test event when you're satisfied.

That's the full loop. You're done.

---

## Troubleshooting

### "Permission denied" when creating events
You're either not signed in, or your email isn't in the `isExec()` list in `firestore.rules`. Check the rules in the Firebase console (**Firestore → Rules**) and confirm your email is there. Republish if you edited.

### Google sign-in popup says "auth/unauthorized-domain"
You skipped step 3.3. Add your `github.io` domain to Firebase Authentication → Settings → Authorized domains.

### Roster shows "Loading roster…" forever
Either the seeder hasn't been run yet, or your Firebase config in `js/firebase-config.js` has a typo. Open the browser console (F12) to see the actual Firebase error.

### Adding a new exec officer
Edit `firestore.rules`, add their email to the allowlist, paste the updated rules into the Firebase console (**Firestore → Rules → Publish**). Takes 30 seconds. No code redeploy needed.

### Removing an exec officer
Same as above but remove the email. Their existing data stays — they just can't write anymore.

### Backing up the data
Firebase console → **Firestore Database → Import/export** tab. Free monthly export to a Google Cloud Storage bucket. Do this before big changes.

### Anyone can see the data even without signing in?
Yes, by design. Brothers checking in can read the event list and the roster (they need to, in order to find their name). They can write their own check-in but can't read or modify anyone else's. Exec sign-in is required for create/edit/delete.

### Want to lock down reads too?
Edit `firestore.rules` and change `allow read: if true;` to `allow read: if isExec();` on the relevant collections. Brothers won't be able to check in anymore unless they also sign in — usually not what you want, but it's an option.
