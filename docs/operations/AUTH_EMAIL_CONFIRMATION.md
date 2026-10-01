# Email confirmation and email changes

Production Supabase Auth uses **Confirm email on** (`mailer_autoconfirm: false`) and **Secure email change on**. This was verified on 2026-09-27 with a new account and two test inboxes.

- A new signup has no session until its confirmation link is opened. `handle_new_user()` saves the registration profile fields from auth metadata in the signup transaction; the browser shows the confirmation screen and can resend the email.
- With both settings on, an email change sends a link to each address. The first link leaves the old address in place; the second completes the change. The instructions in `ChangeEmailPage.jsx` rely on this behavior.
- Turning **Confirm email off** changes the secure email-change flow in this project: one click on either link completes the change. If that setting changes, update the customer instructions and test the flow before release.

Keep the SMTP sender and production redirect allow list configured in Supabase Auth. After any auth-setting or email-template change, use a temporary account to verify signup, delivery, link redirect, profile fields, and both email-change links, then delete the test account.

## When confirmation and reset emails stop sending

Supabase Auth sends four emails through one SMTP server: signup confirmation, resend confirmation, password reset, and email change. Production uses Gmail SMTP (`smtp.gmail.com`, port 587, user `ship2doorofficial@gmail.com`) with a Google **app password**. Announcements, trip-reschedule emails and daily reminders use Resend instead and are not affected.

**Symptoms.** New customers see "We couldn't send your confirmation email right now…" on Register; Forgot password reports that the email could not be sent; nobody receives reset links. Login, bookings, payments and push notifications keep working.

**Common causes.** The Gmail password was changed (Google revokes every app password on that account); 2-Step Verification was turned off; Google blocked the account; Gmail's daily sending limit (about 500/day) was reached, which clears by itself the next day.

**Fix (about 10 minutes, needs the Gmail account and the Supabase dashboard; an in-app admin cannot do this):**

1. Confirm it: on Forgot password, enter an inbox you can check and see whether the email arrives.
2. Sign in to `ship2doorofficial@gmail.com` → myaccount.google.com → **Security**. Make sure **2-Step Verification is on**.
3. Open **App passwords**, create one named `Supabase`, and copy the 16-letter password. Google shows it only once.
4. Supabase dashboard → **CargoExpressPH Project** → **Authentication → Emails → SMTP Settings**. Paste it into **Password**, leave host, port and username unchanged, and **Save**.
5. Repeat step 1. Customers who failed during the outage only need to try again.

Never paste the app password into chat, tickets or the repository; it belongs only in the Supabase SMTP settings.

**Only one SMTP server.** Supabase holds one host, username and password at a time and has no automatic fallback. Extra app passwords on the same Gmail account are not a backup: Google revokes them all together. A real backup is a credential for a *different* sender, kept somewhere safe and switched in by hand at step 4, for example Resend's SMTP (`smtp.resend.com`, port 587, username `resend`, password = a Resend API key, sender on a domain verified in Resend; free plan about 100 emails/day).
