# Envelope Budget

A digital envelope budget for a household that shares one checking account. Every dollar of each paycheck goes into a bucket (Gas, Groceries, Mortgage…). Card purchases come in from your bank, and the phone of whoever used the card gets a notification asking which bucket it was for. Bills that come out on autopay file themselves.

- Weekly or every-two-weeks pay; only the base pay you choose is budgeted.
- Spending buckets, monthly bills (fixed or variable), and savings goals with a target date.
- Leftover money rolls over until you move it.
- Works on iPhone and Android as a home-screen app.

Everything runs on free plans: **GitHub Pages** (the app), **Supabase** (database, sign-in and bank sync) and **Plaid** (bank connection, free Trial for personal use).

## Set up your own copy (about 45 minutes)

You need: a GitHub account, a Supabase account, and a Plaid account.

### 1. Copy this repository
Click **Use this template** (or **Fork**) on GitHub. Keep it **public** so GitHub Pages is free. Only code lives here, never your data or keys.

### 2. Supabase
1. At supabase.com/dashboard create a **Free** organization and a new project (any region near you). Save the database password somewhere safe.
2. Open **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it.
3. **Authentication → Emails → Magic Link** template: replace the body with something that shows the code, e.g.
   `<h2>Your sign-in code</h2><p style="font-size:28px;letter-spacing:4px"><b>{{ .Token }}</b></p>`
4. Generate notification keys: run `npx web-push generate-vapid-keys` on any computer with Node, or ask an AI assistant to make a VAPID key pair.
5. In **SQL Editor**, run (fill in your values):
   ```sql
   insert into server_config(key, value) values
     ('vapid_public',  'YOUR_PUBLIC_KEY'),
     ('vapid_private', 'YOUR_PRIVATE_KEY'),
     ('hmac_secret',   encode(gen_random_bytes(32), 'hex')),
     ('app_url',       'https://YOUR-GITHUB-NAME.github.io/YOUR-REPO/');
   ```
6. Deploy the three functions in `supabase/functions/` (`plaid`, `plaid-webhook`, `quick`) with the Supabase CLI:
   ```
   supabase functions deploy plaid
   supabase functions deploy plaid-webhook --no-verify-jwt
   supabase functions deploy quick --no-verify-jwt
   ```
   (Each folder needs `core.ts` copied from `_shared/` next to its `index.ts`; they're already there.)

### 3. Plaid
1. Sign up at dashboard.plaid.com/signup and choose **Personal use** (free Trial, up to 10 bank logins).
2. Under **Developers → Keys** copy your **client_id** and **Production secret**.
3. In Supabase **Edge Functions → Secrets** add `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` = `production`.
4. If your bank uses its own login page (Chase, Bank of America, Wells Fargo and others), Plaid may ask you to finish its application/questionnaire before that bank works. Add your app address under **Allowed redirect URIs** and set the Supabase secret `PLAID_REDIRECT_URI` to the same address.

### 4. Point the app at your Supabase
Edit `web/config.js` with your project URL, publishable (anon) key from **Project Settings → API**, and the VAPID **public** key. Commit.

### 5. Turn on GitHub Pages
**Settings → Pages → Build and deployment → GitHub Actions**. The included workflow publishes the `web/` folder. Your app will be at `https://YOUR-GITHUB-NAME.github.io/YOUR-REPO/`.

### 6. Start using it
1. Open the app on your phone, add it to your home screen, and sign in with your email.
2. Set your pay and buckets, then **Household → Set starting balances**.
3. **Household → Connect bank**, then **Turn on notifications**.
4. Enter each person's debit card last 4 digits so purchases go to the right phone.
5. Invite your spouse by email from **Household**, and have them do steps 1 and 3 on their phone.

## Notes
- The app never sees or stores your bank balance; it tracks buckets from your starting balances, paydays and purchases.
- Which card made a purchase comes from the last 4 digits your bank prints in the transaction description. If your bank doesn't include them, both phones get the notification.
- `test/sync_test.ts` checks the bank-sync rules with a fake bank: `deno run -A test/sync_test.ts`.
