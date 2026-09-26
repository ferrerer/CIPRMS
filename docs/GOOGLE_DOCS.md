# Google Docs — MOA/MOU agreement drafts

CIPRMS can start an MOA or MOU draft in Google Docs from any Partnership Request. The draft is filled in from the
request, lives in the CIRL office's Google Drive, and is shared automatically with the people on that request.

| Who | Access to the draft | Where they find it in CIPRMS |
|---|---|---|
| Administrator, CIRL Staff (active) | Edit | Requests → open a request → **Agreement Draft (Google Docs)** |
| The partner who submitted the request | Comment | Monitoring → the request's **Draft** button |
| College Deans of the request's unit | View | The Google share e-mail (they have no Requests page) |

Google enforces these permissions. Everyone also receives Google's own "shared with you" e-mail with the link, and
the partner gets a CIPRMS notification.

## 1. One-time setup (Google Cloud)

Use the same Google Cloud project and OAuth client that CIPRMS already uses for Google sign-in and Google Calendar.

1. **Enable the Drive API:** Google Cloud Console → APIs & Services → Library → search **Google Drive API** → Enable.
   (The Google Docs API is not needed; drafts are created through Drive.)
2. **Add the permission to the consent screen:** APIs & Services → OAuth consent screen → Data access / Scopes → Add
   `https://www.googleapis.com/auth/drive.file` ("See, edit, create and delete only the specific Google Drive files
   you use with this app"). It is a non-sensitive scope, so no Google verification is required.
3. **Register the redirect URI:** APIs & Services → Credentials → your OAuth client → Authorized redirect URIs → add
   the address shown on the Settings card, e.g.
   - local test: `http://localhost:3001/api/google-docs/callback`
   - live site: `https://<your-domain>/api/google-docs/callback`
4. If the consent screen is in **Testing** mode, add the Google account you will connect under **Test users**.
   (Testing-mode tokens expire after 7 days; publish the app to keep the connection permanent.)

The server needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_TOKEN_ENCRYPTION_KEY` (the same three values
Google Calendar uses).

## 2. Connect the office Google account (Administrator)

1. Sign in to CIPRMS as an Administrator → **Settings → Integrations**.
2. Under **Google Docs**, click **Connect Google Docs**.
3. Sign in with the **CIRL office Google account** (it will own every draft) and click **Allow**.
4. You land back on Settings with "Google Docs connected and checked" and the connected account shown.

**Check connection** re-tests it at any time. **Disconnect** stops new drafts; existing drafts stay in Drive with
their sharing. Google Docs and Google Calendar are separate connections: connecting or disconnecting one does not
affect the other.

## 3. Create a draft (Administrator / CIRL Staff)

1. **Requests → Partnership Requests** → click **Review** / **View** on a request.
2. In **Agreement Draft (Google Docs)**, click **+ MOA draft** or **+ MOU draft**.
3. The draft appears with **Open in Google Docs** and the list of people it was shared with. It opens as a normal
   Google Doc: a standard agreement layout with the request's details filled in. Replace every `[bracketed]` item.

Other buttons on a draft:
- **Share** icon: shares it again with the request's current staff, partner and deans (e.g. after new staff joined,
  or to retry an address that failed).
- **Unlink** icon: removes the draft from the request in CIPRMS. The Google Doc itself is kept in Drive.

## 4. Partner review

The partner opens **Monitoring**, clicks **Draft** on the request and uses **Open in Google Docs**. They must be signed
in to Google with the same e-mail address they use for CIPRMS. They can read the draft and add comments or
suggestions; CIRL staff resolve them in Google Docs.

When the agreement is final, download it from Google Docs (File → Download → PDF) and upload it to the request's
Draft Collaboration as the final version, as before.

## Troubleshooting

| Message | Fix |
|---|---|
| "Google Docs is not connected" | An Administrator connects it in Settings → Integrations. |
| "The Google Drive API is not enabled…" | Step 1.1 above. |
| "Google rejected the redirect address" | Add the exact redirect URI shown on the Settings card (step 1.3). |
| "Google no longer accepts the stored authorization" | Disconnect and connect again (Testing-mode tokens expire after 7 days). |
| "Could not share with …" under a draft | That address could not be invited (typo, or Google refused it). Fix the user's e-mail in User Management, then use the Share icon. |
| A person gets "You need access" in Google Docs | They are signed in to Google with a different e-mail than their CIPRMS account. |
