// Privacy Policy tailored to NW Baseball Stats (Supabase auth, Stripe
// payments, Vercel/DigitalOcean hosting). Starter template — have a
// professional review before relying on it.

const EFFECTIVE = 'June 22, 2026'
const CONTACT = 'info@nwbaseballstats.com'

function Section({ title, children }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-nw-teal dark:text-gray-100 mb-1.5">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

export default function Privacy() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Privacy Policy</h1>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Last updated: {EFFECTIVE}</p>

      <div className="space-y-6 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
        <p>
          This Privacy Policy explains what information NW Baseball Stats (nwbaseballstats.com, the
          &ldquo;Service,&rdquo; operated by Nate Rasmussen) collects, how we use it, and the choices
          you have. By using the Service, you agree to this policy.
        </p>

        <Section title="Information we collect">
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <span className="font-semibold">Account information.</span> When you create an account we
              collect your email address (and a password, which is stored securely by our authentication
              provider). Authentication is handled by Supabase.
            </li>
            <li>
              <span className="font-semibold">Payment information.</span> Paid subscriptions are processed
              by Stripe. Stripe collects and stores your payment details directly; we do not receive or
              store your full card number. We retain limited records such as your subscription status and
              billing history.
            </li>
            <li>
              <span className="font-semibold">Usage and device data.</span> Like most websites, our
              servers and hosting providers automatically log basic technical information such as IP
              address, browser type, pages viewed, and timestamps.
            </li>
            <li>
              <span className="font-semibold">Preferences.</span> We use cookies and your browser&rsquo;s
              local storage to keep you signed in and to remember settings (for example, sort and filter
              choices).
            </li>
          </ul>
        </Section>

        <Section title="How we use information">
          <ul className="list-disc pl-5 space-y-1">
            <li>to provide, maintain, and improve the Service;</li>
            <li>to create and manage your account and authenticate you;</li>
            <li>to process subscriptions and payments and provide premium features;</li>
            <li>to respond to your messages and support requests; and</li>
            <li>to monitor usage, prevent abuse, and keep the Service secure.</li>
          </ul>
        </Section>

        <Section title="Service providers we use">
          <p>We share limited information with trusted providers that help us run the Service:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><span className="font-semibold">Supabase</span> — accounts, authentication, and database;</li>
            <li><span className="font-semibold">Stripe</span> — subscription payments and billing;</li>
            <li><span className="font-semibold">Vercel and DigitalOcean</span> — website and API hosting.</li>
          </ul>
          <p>These providers process data on our behalf under their own privacy and security terms.</p>
        </Section>

        <Section title="Selling your information">
          <p>
            We do not sell your personal information, and we do not share it with third parties for their
            own advertising. We only share information as described in this policy or as required by law.
          </p>
        </Section>

        <Section title="Cookies and local storage">
          <p>
            We use cookies and local storage that are necessary for the Service to function (such as
            keeping you logged in and saving preferences). You can clear or block these through your
            browser settings, but some features may not work properly if you do.
          </p>
        </Section>

        <Section title="Data retention">
          <p>
            We keep your account information for as long as your account is active. If you delete your
            account, we remove or anonymize your personal information within a reasonable period, except
            where we need to retain it to meet legal, accounting, or security obligations.
          </p>
        </Section>

        <Section title="Security">
          <p>
            We use reasonable technical and organizational measures to protect your information. No method
            of transmission or storage is completely secure, however, so we cannot guarantee absolute
            security.
          </p>
        </Section>

        <Section title="Your choices and rights">
          <p>
            You can review or update your account information, cancel your subscription, or request that
            we delete your account at any time. To make a request, email{' '}
            <a href={`mailto:${CONTACT}`} className="text-nw-teal dark:text-teal-400 font-semibold hover:underline">{CONTACT}</a>.
            Depending on where you live, you may have additional rights over your personal information.
          </p>
        </Section>

        <Section title="Children&rsquo;s privacy">
          <p>
            The Service is not directed to children under 13, and we do not knowingly collect personal
            information from them. If you believe a child has provided us information, please contact us
            and we will delete it.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            We may update this policy from time to time. When we do, we will revise the &ldquo;Last
            updated&rdquo; date above. Significant changes may be highlighted on the site.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about your privacy? Email{' '}
            <a href={`mailto:${CONTACT}`} className="text-nw-teal dark:text-teal-400 font-semibold hover:underline">{CONTACT}</a>.
          </p>
        </Section>
      </div>
    </div>
  )
}
