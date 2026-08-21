import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import LegalPageLayout from '../../components/legal/LegalPageLayout';

const SECTIONS = [
  { id: 'acceptance', label: 'Acceptance' },
  { id: 'account', label: 'Accounts' },
  { id: 'services', label: 'Services and bookings' },
  { id: 'cargo', label: 'Cargo and prohibited use' },
  { id: 'payments', label: 'Payments and refunds' },
  { id: 'communications', label: 'Communications' },
  { id: 'availability', label: 'Availability and changes' },
  { id: 'termination', label: 'Suspension and termination' },
  { id: 'responsibility', label: 'Responsibility and liability' },
  { id: 'contact', label: 'Contact' },
];

const TermsPage = () => (
  <LegalPageLayout
    title="Terms of Service"
    eyebrow="Your agreement with us"
    description="These terms explain the rules for using Cargo Express PH accounts, booking tools, tracking features, and delivery services."
    Icon={FileText}
    sections={SECTIONS}
  >
    {({ companyName }) => (
      <>
        <p className="legal-intro">
          These Terms of Service (the “Terms”) apply to the Cargo Express PH website, customer portal,
          progressive web app, and related delivery services (collectively, the “Service”). The Service is
          operated by {companyName} (“we”, “us”, or “our”).
        </p>

        <section id="acceptance">
          <h2>1. Acceptance of these Terms</h2>
          <p>
            By creating an account, booking a shipment, or using the Service, you confirm that you have read
            and understood these Terms and agree to follow them. If you do not agree, do not create an account
            or use the Service. If you use the Service for another person or organization, you confirm that you
            have authority to accept these Terms on their behalf.
          </p>
        </section>

        <section id="account">
          <h2>2. Account responsibilities</h2>
          <ul>
            <li>Provide information that is accurate, complete, and kept up to date.</li>
            <li>Keep your password and account access details confidential.</li>
            <li>Tell us promptly through the available contact channels if you suspect unauthorized access.</li>
            <li>Use the account only for lawful, genuine delivery and tracking activity.</li>
          </ul>
          <p>
            You are responsible for activity performed through your account unless it resulted from a failure
            by us to apply reasonable security measures.
          </p>
        </section>

        <section id="services">
          <h2>3. Services and bookings</h2>
          <p>
            The Service lets customers submit delivery requests, provide sender and receiver information,
            monitor shipment status, receive service updates, and communicate with Cargo Express PH. A request
            is subject to route availability, operational review, and confirmation. Submitting a request does
            not by itself guarantee acceptance or a particular delivery time.
          </p>
          <p>
            You must provide complete and accurate shipment information, including contact details, addresses,
            cargo description, and any information needed for safe handling. Delivery timing, routing, and final
            charges can be affected by actual cargo condition or weight, traffic, weather, facility schedules,
            government requirements, and other operational conditions.
          </p>
        </section>

        <section id="cargo">
          <h2>4. Cargo and prohibited use</h2>
          <p>
            You may not use the Service to request transport of unlawful, stolen, counterfeit, dangerous,
            explosive, toxic, weapon-related, or otherwise restricted cargo. You are responsible for packaging,
            disclosure, labeling, permits, and compliance requirements that apply to your shipment.
          </p>
          <p>
            We may inspect, delay, reject, hold, or report cargo when reasonably necessary for safety, security,
            legal compliance, or service integrity. The examples above are not an exhaustive list of restricted
            items.
          </p>
        </section>

        <section id="payments">
          <h2>5. Payments, charges, and refunds</h2>
          <p>
            Applicable charges and payment instructions are shown in the Service or communicated during the
            delivery process. Where an external payment provider is offered, payment details may be processed
            directly by that provider under its own terms and privacy notice. We do not ask you to send passwords,
            one-time codes, or complete card credentials through chat or support messages.
          </p>
          <p>
            Cancellations, refunds, adjustments, and outstanding balances are handled according to the applicable
            service workflow, the information shown at the time of the transaction, and applicable law. Contact
            us promptly if a charge appears incorrect.
          </p>
        </section>

        <section id="communications">
          <h2>6. Communications and user content</h2>
          <p>
            We may send account, booking, delivery, security, and support communications by email, phone,
            in-app message, or push notification where enabled. These operational messages are part of the
            Service; marketing communications, if any, should be separately identified and handled according to
            applicable consent requirements.
          </p>
          <p>
            You retain responsibility for the information, messages, and images you submit. You authorize us to
            use that content only as reasonably necessary to provide, secure, document, and support the Service,
            or to comply with law.
          </p>
        </section>

        <section id="availability">
          <h2>7. Availability, intellectual property, and changes</h2>
          <p>
            We work to keep the Service reliable, but access may be interrupted by maintenance, connectivity
            problems, device limitations, weather, emergencies, or events outside our reasonable control. The
            Cargo Express PH name, interface, content, and software are protected by applicable intellectual
            property laws. You may use them only as permitted by these Terms and applicable law.
          </p>
          <p>
            We may update the Service or these Terms when our operations, technology, or legal obligations change.
            We will publish the current version here and update the effective date. If a change materially affects
            your rights or obligations, we will provide an appropriate notice where required.
          </p>
        </section>

        <section id="termination">
          <h2>8. Suspension and termination</h2>
          <p>
            We may restrict or suspend access when reasonably necessary to protect customers, cargo, the Service,
            or our legal obligations, including where an account is used for fraud, abuse, prohibited cargo, or a
            serious breach of these Terms. You may stop using the Service at any time. Ending access does not remove
            obligations or rights that arose before termination, including payment, dispute, security, or legal
            record requirements.
          </p>
        </section>

        <section id="responsibility">
          <h2>9. Responsibility and liability</h2>
          <p>
            You are responsible for losses or delays caused by inaccurate information, inadequate packaging,
            undisclosed or prohibited cargo, misuse of your account, or failure to follow instructions. We are not
            responsible for interruptions or delays caused by events outside our reasonable control.
          </p>
          <p>
            Nothing in these Terms excludes or limits a right, remedy, or liability that cannot lawfully be
            excluded or limited. Subject to that requirement, our responsibility is determined by applicable law,
            the confirmed service arrangement, and the facts of the individual shipment.
          </p>
        </section>

        <section id="contact">
          <h2>10. Contact</h2>
          <p>
            Questions about these Terms or a shipment can be sent through the <Link to="/about#contact">Contact Us</Link>
            section of our website. The current version of these Terms is always available on <Link to="/terms">this page</Link>.
          </p>
        </section>

      </>
    )}
  </LegalPageLayout>
);

export default TermsPage;
