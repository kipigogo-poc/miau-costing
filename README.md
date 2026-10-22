# Drink Costing

Recipe costing, nutrition and online ordering for a coffee shop. Runs on Firebase (Hosting + Firestore + Google sign-in).

- **Staff app:** `/` (Google sign-in, allowed emails only)
- **Customer ordering:** `/order.html` (no login)

Every push to `main` is checked and then deployed automatically by GitHub Actions.

## One-time setup (about 30 minutes)

### 1. Firebase project
1. https://console.firebase.google.com → **Add project**.
2. **Authentication** → Sign-in method → **Google** → Enable.
3. **Firestore Database** → Create → *Production mode* → location **asia-southeast1** (can't be changed later).
4. **Project settings** → Your apps → **Web** → copy the config values.

### 2. Fill in three files and commit
| File | What to change |
|---|---|
| `public/config.js` | Paste the web config (keep `authDomain` as Firebase gives it). Set `SHOP_NAME`. |
| `firestore.rules` | Replace `your.email@gmail.com` with your Google email (lowercase). |
| `.firebaserc` | Replace `your-project` with your project ID. |

Run `node scripts/check.mjs` to confirm everything is filled in.

### 3. Deploy key for GitHub
1. Google Cloud console → your project → **IAM & Admin → Service Accounts → Create**. Name: `github-deploy`.
2. Give it these roles: **Firebase Hosting Admin**, **Firebase Rules Admin**, **Service Account User**, **Service Usage Consumer**.
3. Open the account → **Keys → Add key → JSON**. A file downloads. Keep it private; never commit it.
4. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**.
   Name `FIREBASE_SERVICE_ACCOUNT`, paste the whole JSON file. Then delete the downloaded file.
5. GitHub repo → **Settings → Environments → New environment** `production`. Optional: add yourself as a required reviewer to approve each deploy.

### 4. Deploy
Push to `main` (or **Actions → Deploy → Run workflow**). Open `https://YOUR-PROJECT-ID.web.app`, sign in, then **Account → Restore from file** with your backup.

## Day to day
- **Change the app:** edit, commit, push. GitHub deploys in about a minute. Watch it under the **Actions** tab.
- **Add a staff member:** add their email to `firestore.rules`, commit, push.
- **Undo a bad release:** Firebase console → Hosting → release history → **Rollback**, or revert the commit and push.
- **Backups:** in the app, Account → Download backup. Weekly, kept in Google Drive. Backups are not stored in this repository.

## Online ordering
Orders → **Online menu**: shop name, GCash number, upload your GCash QR, a photo per drink, tick **Sell**, **Publish**, switch to **Open**. Share `/order.html`.
Always confirm the amount and reference in your GCash app before tapping **Confirm paid**.

## Check the security rules once after the first deploy
Firestore → Rules → **Rules Playground**:
| Simulate | Path | Auth | Expected |
|---|---|---|---|
| get | `shops/main/menu/x` | Unauthenticated | Allowed |
| get | `shops/main/items/milk` | Unauthenticated | Denied |
| get | `shops/main/items/milk` | Google, your email, verified | Allowed |
| get | `shops/main/items/milk` | Google, another email | Denied |
| create | `shops/main/orders/aaaaaaaaaaaaaaaaaaaaaaaa` (shop Closed) | Unauthenticated | Denied |

## Files
| Path | Purpose |
|---|---|
| `public/index.html` | Staff app (costing, menu, orders) |
| `public/order.html`, `order.js` | Customer ordering page |
| `public/auth.js` | Google sign-in, database connection, backup/restore |
| `public/config.js` | Your Firebase project settings |
| `public/firebase*.js` | Firebase SDK 12.19.0, bundled (no external CDN) |
| `firestore.rules` | Who can read and write what |
| `firebase.json` | Hosting settings and security headers |
| `scripts/check.mjs` | Pre-deploy checks |
| `.github/workflows/deploy.yml` | Check + deploy on push |

Keep this repository **private**: it contains your staff email list.
