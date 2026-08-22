import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Scale, ShieldCheck } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { LEGAL_DOCUMENTS } from '../../constants/legalDocuments';

const TERMS_SECTIONS = [
  {
    heading: '1. Agreement and scope',
    body: [
      'These Terms of Service govern your access to and use of Cargo Express PH’s website, account portal, booking, tracking, payment and customer-support services (collectively, the “Services”). By creating an account, placing a booking, or otherwise using the Services, you agree to these Terms and our Privacy Policy.',
      'If you use the Services for an organisation, you confirm that you are authorised to accept these Terms on that organisation’s behalf.',
    ],
  },
  {
    heading: '2. Accounts and account security',
    body: [
      'You must provide accurate, current and complete registration information and keep it updated. You are responsible for safeguarding your account credentials and for activity carried out through your account. Notify us promptly through our Contact Us page if you believe your account has been accessed without permission.',
      'We may suspend or protect an account where we reasonably believe it is compromised, misleading, unlawful, or being used in breach of these Terms.',
    ],
  },
  {
    heading: '3. Bookings, shipments and prohibited items',
    body: [
      'A booking is a request for carriage and is subject to service availability, collection or drop-off checks, inspection where permitted by law, applicable charges, and operational requirements. Delivery dates and tracking updates are estimates unless we expressly confirm otherwise in writing.',
      'You must describe shipments truthfully, package them safely, provide complete sender and recipient details, and comply with all applicable laws. You must not submit dangerous, illegal, prohibited, restricted, counterfeit, perishable, improperly declared, or inadequately packaged items. We may refuse, return, hold, or report a shipment where required for safety, security, or legal compliance.',
    ],
  },
  {
    heading: '4. Fees, payments and changes',
    body: [
      'Displayed rates, surcharges, and payment options may depend on route, weight, dimensions, shipment characteristics, and other verified operational details. You are responsible for authorised charges associated with your booking. If a shipment’s declared details differ from verified details, we may explain the adjusted charge and request payment before continuing service where permitted.',
      'Cancellation, refund, and service-change handling depends on the shipment status and the applicable booking terms presented at the time of your request. Statutory consumer rights are not limited by these Terms.',
    ],
  },
  {
    heading: '5. Acceptable use',
    body: [
      'Do not interfere with the Services, attempt unauthorised access, circumvent security controls, scrape data, introduce harmful code, impersonate another person, or use the Services for fraud or unlawful activity. You may use the Services only for their intended personal or authorised business purposes.',
    ],
  },
  {
    heading: '6. Service changes and availability',
    body: [
      'We work to keep the Services reliable and accurate, but they may be unavailable or delayed for maintenance, connectivity, safety, weather, third-party, or operational reasons. We may update, improve, or discontinue features where reasonably necessary. We will not exclude liability that cannot be excluded under applicable law.',
    ],
  },
  {
    heading: '7. Intellectual property',
    body: [
      'The Services, including their software, design, branding, and content, are owned by or licensed to Cargo Express PH and are protected by applicable intellectual-property laws. These Terms give you a limited, personal, non-transferable right to use the Services in accordance with these Terms; they do not transfer ownership to you.',
    ],
  },
  {
    heading: '8. Privacy',
    body: [
      'Our collection and handling of personal information is described in our Privacy Policy. Please read it before using the Services.',
    ],
  },
  {
    heading: '9. Changes to these Terms',
    body: [
      'We may update these Terms when our Services, legal obligations, or operational practices change. The current version and effective date will be published on this page. Material changes will be communicated through the Services or another reasonable channel before they take effect where required by law.',
    ],
  },
  {
    heading: '10. Contact and governing law',
    body: [
      'For questions, complaints, or notices about these Terms, contact Cargo Express PH through the Contact Us section of our website. These Terms are governed by the applicable laws of the Republic of the Philippines, subject to any mandatory consumer-protection rights that apply to you.',
    ],
  },
];

const PRIVACY_SECTIONS = [
  {
    heading: '1. Who we are and this policy',
    body: [
      'Cargo Express PH provides cargo delivery and related digital services. This Privacy Policy explains how we handle personal information when you use our website, create an account, make or receive a shipment, contact us, or otherwise interact with our Services.',
      'We handle personal information in accordance with applicable Philippine privacy law, including the Data Privacy Act of 2012 and its implementing rules where applicable.',
    ],
  },
  {
    heading: '2. Information we collect',
    body: [
      'Depending on how you use the Services, we may collect account and contact information (such as name, email address, mobile number, and social-media contact name); collection, delivery, and recipient details; shipment and booking information; communications with support; payment and transaction status; device, browser, and log information; and proof or photos you provide in connection with a shipment.',
      'Please provide only information that is necessary for the shipment or service request, and ensure you have authority to provide information about a recipient or other person.',
    ],
  },
  {
    heading: '3. Why we use information',
    body: [
      'We use personal information to create and secure accounts; process, coordinate, track, and support shipments; communicate service updates; process authorised payments; prevent fraud and protect the security of our Services; comply with legal obligations; improve service quality; and respond to enquiries or disputes.',
      'We process information only where we have an appropriate legal basis, such as performing our agreement with you, complying with law, protecting legitimate interests such as service security, or obtaining consent where consent is required.',
    ],
  },
  {
    heading: '4. When information is shared',
    body: [
      'We share information only as needed to operate the Services: with authorised personnel and delivery partners involved in your shipment; payment providers for authorised transactions; service providers that securely support our technology, communications, storage, or operations; and public authorities or other parties when required by law or needed to protect rights, safety, or security.',
      'We require service providers to handle information for authorised purposes and with appropriate safeguards. We do not permit them to use it for their own unrelated marketing.',
    ],
  },
  {
    heading: '5. Retention and security',
    body: [
      'We retain information for as long as reasonably necessary for the purposes described above, including to provide the Services, maintain records, resolve disputes, meet legal obligations, and enforce agreements. Retention periods vary with the type of information and legal requirements.',
      'We use organisational and technical measures designed to protect information against unauthorised access, loss, misuse, alteration, or disclosure. No online service can guarantee absolute security, so please protect your credentials and notify us promptly if you suspect unauthorised access.',
    ],
  },
  {
    heading: '6. Your choices and privacy rights',
    body: [
      'Subject to applicable law, you may request access to, correction of, or deletion of personal information; object to or restrict certain processing; withdraw consent where processing is based on consent; and lodge a complaint with the National Privacy Commission. We may ask you to verify your identity before acting on a request and may retain information where law permits or requires it.',
      'To make a privacy request or ask about this Policy, contact us through the Contact Us section of our website and state that your request concerns privacy. We will respond in accordance with applicable law.',
    ],
  },
  {
    heading: '7. Children',
    body: [
      'The Services are not intended for children who cannot legally enter into the relevant agreement. If you believe a child has provided personal information without appropriate authority, please contact us so we can review the matter.',
    ],
  },
  {
    heading: '8. Updates to this Policy',
    body: [
      'We may update this Policy when our practices, Services, or legal requirements change. The current version and effective date will be published on this page. For material changes, we will provide additional notice where required by law.',
    ],
  },
];

const CONTENT = { terms: TERMS_SECTIONS, privacy: PRIVACY_SECTIONS };

const LegalPage = ({ documentKey }) => {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const document = LEGAL_DOCUMENTS[documentKey];
  const isTerms = documentKey === 'terms';
  const Icon = isTerms ? Scale : ShieldCheck;
  const other = LEGAL_DOCUMENTS[isTerms ? 'privacy' : 'terms'];
  const returnToRegister = searchParams.get('returnTo') === 'register';
  const backPath = returnToRegister ? '/register?step=2' : '/about';
  const backLabel = 'Back';
  const relatedPath = `${other.path}${returnToRegister ? '?returnTo=register' : ''}`;

  usePageTitle(document.title, `${document.title} for Cargo Express PH. Effective ${document.effectiveDate}.`);

  return (
    <main className="legal-page">
      <nav className="legal-nav" aria-label="Legal document navigation">
        <Link to={backPath} state={returnToRegister ? location.state : undefined} className="legal-back">
          <ArrowLeft size={16} /> {backLabel}
        </Link>
      </nav>

      <section className="legal-hero" aria-labelledby="legal-title">
        <div className="legal-eyebrow"><Icon size={16} /> Legal information</div>
        <h1 id="legal-title">{document.title}</h1>
        <p>Clear terms for using Cargo Express PH and transparent information about your rights.</p>
        <p className="legal-effective-date">Effective date: {document.effectiveDate}</p>
      </section>

      <div className="legal-content-wrap">
        <aside className="legal-aside" aria-label="Related legal document">
          <p>Related document</p>
          <Link to={relatedPath} state={returnToRegister ? location.state : undefined}>{other.title} <ArrowLeft size={15} /></Link>
        </aside>
        <article className="legal-document">
          <p className="legal-intro">Please read this document carefully. By using Cargo Express PH, you acknowledge the terms that apply to the Services.</p>
          {CONTENT[documentKey].map((section) => (
            <section key={section.heading} className="legal-section" aria-labelledby={section.heading.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}>
              <h2 id={section.heading.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}>{section.heading}</h2>
              {section.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </section>
          ))}
        </article>
      </div>

      <footer className="legal-footer">
        <span>© {new Date().getFullYear()} Cargo Express PH</span>
        <div>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/about#contact">Contact us</Link>
        </div>
      </footer>
    </main>
  );
};

export const TermsPage = () => <LegalPage documentKey="terms" />;
export const PrivacyPage = () => <LegalPage documentKey="privacy" />;
