# Email confirmation and email changes

Production Supabase Auth uses **Confirm email on** (`mailer_autoconfirm: false`) and **Secure email change on**. This was verified on 2026-09-27 with a new account and two test inboxes.

- A new signup has no session until its confirmation link is opened. `handle_new_user()` saves the registration profile fields from auth metadata in the signup transaction; the browser shows the confirmation screen and can resend the email.
- With both settings on, an email change sends a link to each address. The first link leaves the old address in place; the second completes the change. The instructions in `ChangeEmailPage.jsx` rely on this behavior.
- Turning **Confirm email off** changes the secure email-change flow in this project: one click on either link completes the change. If that setting changes, update the customer instructions and test the flow before release.

Keep the SMTP sender and production redirect allow list configured in Supabase Auth. After any auth-setting or email-template change, use a temporary account to verify signup, delivery, link redirect, profile fields, and both email-change links, then delete the test account.
