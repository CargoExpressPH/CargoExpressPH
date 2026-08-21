import { ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import LegalPageLayout from '../../components/legal/LegalPageLayout';

const SECTIONS = [
  { id: 'who-we-are', label: 'Who we are' },
  { id: 'data-we-collect', label: 'Data we collect' },
  { id: 'how-we-use', label: 'How we use data' },
  { id: 'sharing', label: 'Sharing and providers' },
  { id: 'retention', label: 'Retention' },
  { id: 'security', label: 'Security' },
  { id: 'your-rights', label: 'Your rights' },
  { id: 'storage', label: 'Cookies and storage' },
  { id: 'children', label: 'Children' },
  { id: 'changes', label: 'Changes and contact' },
];

const PrivacyPage = () => (
  <LegalPageLayout
    title="Privacy Policy"
    eyebrow="How we handle personal data"
    description="This notice explains what information Cargo Express PH collects, why we use it, who may receive it, and how you can exercise your privacy rights."
    Icon={ShieldCheck}
    sections={SECTIONS}
  >
    {({ companyName, companyInfo }) => {
      const contactEmail = companyInfo?.email?.trim() || '';
      const contactPhone = companyInfo?.smart_phone?.trim() || companyInfo?.globe_phone?.trim() || '';

      return (
        <>
          <p className="legal-intro">
            This Privacy Policy describes how {companyName} (“we”, “us”, or “our”) processes personal data
            through the Cargo Express PH website, customer portal, progressive web app, and delivery services.
            It is written in plain language and should be read before you create an account or submit shipment
            information.
          </p>

          <section id="who-we-are">
            <h2>1. Who we are</h2>
            <p>
              {companyName} is the personal information controller for the personal data it collects and uses
              for its own delivery operations. We are accountable for choosing the purposes of processing and for
              applying appropriate safeguards. When another provider processes information for us, we require it
              to handle the data only for the agreed service and with appropriate confidentiality and security
              controls.
            </p>
          </section>

          <section id="data-we-collect">
            <h2>2. Personal data we collect</h2>
            <p>Depending on how you use the Service, we may collect:</p>
            <ul>
              <li><strong>Account data:</strong> name, email address, mobile number, Facebook display name, and authentication identifiers.</li>
              <li><strong>Address and delivery data:</strong> sender and receiver names, contact details, delivery addresses, landmarks, cargo descriptions, tracking references, and delivery status.</li>
              <li><strong>Transaction and support data:</strong> payment status and references, inquiries, support messages, feedback, delivery evidence, and information needed to investigate a dispute.</li>
              <li><strong>Device and technical data:</strong> browser or device information, security and diagnostic information, and push-notification device tokens when you enable notifications.</li>
            </ul>
            <p>
              Passwords are handled by our authentication service and are not stored by Cargo Express PH in
              readable/plaintext form. Do not send passwords, verification codes, or complete payment credentials
              through support messages.
            </p>
          </section>

          <section id="how-we-use">
            <h2>3. How and why we use data</h2>
            <p>We process personal data only for specified, legitimate, and proportionate purposes, including to:</p>
            <ul>
              <li>create and secure your account and authenticate you;</li>
              <li>accept, review, route, track, and complete delivery requests;</li>
              <li>contact senders and receivers about bookings, delivery status, support, and safety;</li>
              <li>process or reconcile payments, refunds, balances, and transaction questions;</li>
              <li>send operational notifications when you enable a notification channel;</li>
              <li>prevent misuse, investigate incidents, maintain records, and improve reliability; and</li>
              <li>comply with lawful requests, regulatory duties, and the establishment or defense of legal claims.</li>
            </ul>
            <p>
              Depending on the purpose, processing may be based on your consent, the performance of a service or
              contract, a legitimate interest that does not override your rights, a legal obligation, or another
              lawful basis permitted by the Data Privacy Act of 2012 and its implementing rules. The registration
              checkboxes record your informed acceptance of this notice and our Terms; they do not mean every
              processing activity depends solely on consent.
            </p>
          </section>

          <section id="sharing">
            <h2>4. Sharing and service providers</h2>
            <p>
              We disclose only the information reasonably needed for the stated purpose. Recipients may include
              authorized Cargo Express PH staff and delivery personnel, the sender or receiver involved in a
              shipment, payment providers when a payment service is used, technology providers that host or secure
              the Service, and government or law-enforcement authorities when disclosure is required or permitted
              by law.
            </p>
            <p>
              Current technology integrations may include Supabase for authentication and database services,
              PayMongo for payment processing when selected, Firebase Cloud Messaging for enabled push
              notifications, and hosting or content-delivery providers. Those providers may process information
              under their own terms and privacy notices, subject to the arrangements and safeguards applicable to
              our use of them.
            </p>
          </section>

          <section id="retention">
            <h2>5. Retention</h2>
            <p>
              We keep personal data only for as long as it is necessary for the purpose for which it was collected,
              to provide the Service, to resolve disputes, to maintain security, or to meet legal, accounting, and
              regulatory requirements. In practice:
            </p>
            <ul>
              <li>Account information is kept while the account is active and for a reasonable period afterward when needed for security, disputes, or legal obligations.</li>
              <li>Delivery, payment, and support records are kept for the period needed to operate the service, reconcile transactions, answer claims, and satisfy applicable recordkeeping requirements.</li>
              <li>Consent records are kept as long as reasonably necessary to demonstrate which document version was accepted and to meet legal or dispute-resolution needs.</li>
              <li>Device and diagnostic information is kept for the limited period appropriate to security, troubleshooting, and service reliability.</li>
            </ul>
            <p>
              When retention is no longer necessary, we securely delete, anonymize, or otherwise dispose of the
              information in accordance with our operational controls and applicable law.
            </p>
          </section>

          <section id="security">
            <h2>6. Security</h2>
            <p>
              We use reasonable technical, organizational, and access-control measures appropriate to the nature
              of the data and the risks involved. No website, device, or transmission method is completely secure,
              so please use a unique password, keep your devices protected, and notify us promptly about suspected
              unauthorized access or disclosure.
            </p>
          </section>

          <section id="your-rights">
            <h2>7. Your privacy rights</h2>
            <p>
              Subject to the conditions and exceptions in applicable law, you may have the right to be informed,
              access and obtain a copy of your personal data, correct inaccurate or incomplete data, object to or
              withdraw consent for processing based on consent, request erasure or blocking where warranted, and
              request data portability. You may also seek damages or file a complaint where the law provides those
              remedies.
            </p>
            <p>
              To make a request, contact us using the details below or the <Link to="/about#contact">Contact Us</Link>
              form. We may need to verify your identity before responding. We will assess requests fairly and
              explain when a legal or operational exception applies. You may also learn more about data-subject
              rights from the <a href="https://privacy.gov.ph/data-subject-rights/" target="_blank" rel="noopener noreferrer">National Privacy Commission</a>.
            </p>
            <div className="legal-callout">
              <strong>Privacy request:</strong> Do not include your password or one-time verification code. Tell
              us the account email, the request you are making, and enough information for us to locate the record.
            </div>
          </section>

          <section id="storage">
            <h2>8. Cookies and local storage</h2>
            <p>
              The Service uses essential browser storage to keep authentication sessions, remember necessary
              preferences, support the progressive web app, preserve a non-sensitive registration draft, and
              maintain notification or install-prompt state. These technologies are used to operate and secure the
              Service, not to collect your password. If you block or clear them, sign-in, drafts, notifications, or
              install behavior may stop working as expected.
            </p>
          </section>

          <section id="children">
            <h2>9. Children</h2>
            <p>
              The Service is intended for people who can lawfully use a delivery service and create an account.
              It is not knowingly directed to children. If you believe a child provided personal data without
              appropriate authorization, contact us so we can review and take appropriate action under applicable
              law.
            </p>
          </section>

          <section id="changes">
            <h2>10. Changes and contact</h2>
            <p>
              We may update this Privacy Policy when our data practices, Service, or legal obligations change. We
              will publish the new version on this page, update the effective date, and provide additional notice
              where required. Earlier versions may be retained for accountability and can be requested where
              appropriate.
            </p>
            <div className="legal-contact-details">
              <strong>Privacy contact</strong>
              {contactEmail ? <a href={`mailto:${contactEmail}`}>{contactEmail}</a> : <Link to="/about#contact">Use our Contact Us form</Link>}
              {contactPhone && <a href={`tel:${contactPhone}`}>{contactPhone}</a>}
              <span>{companyName}</span>
            </div>
          </section>
        </>
      );
    }}
  </LegalPageLayout>
);

export default PrivacyPage;
