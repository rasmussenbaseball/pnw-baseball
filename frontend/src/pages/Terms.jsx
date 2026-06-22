// Terms of Service. Plain-language terms tailored to NW Baseball Stats
// (subscriptions via Stripe, accounts via Supabase, stats from public
// sources, no league/school affiliation). Starter template — have a
// professional review before relying on it.

const EFFECTIVE = 'June 22, 2026'
const CONTACT = 'nate.rasmussen26@gmail.com'

function Section({ title, children }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-nw-teal dark:text-gray-100 mb-1.5">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

export default function Terms() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">Terms of Service</h1>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">Last updated: {EFFECTIVE}</p>

      <div className="space-y-6 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
        <p>
          These Terms of Service (the &ldquo;Terms&rdquo;) govern your use of NW Baseball Stats,
          available at nwbaseballstats.com (the &ldquo;Service&rdquo;). The Service is operated by
          Nate Rasmussen (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;). By accessing or
          using the Service, you agree to these Terms. If you do not agree, please do not use the Service.
        </p>

        <Section title="1. The Service">
          <p>
            NW Baseball Stats provides statistics, analytics, graphics, and related tools covering
            Pacific Northwest college baseball and select summer leagues. Some features are free and
            others require a paid subscription. We may add, change, or remove features at any time.
          </p>
        </Section>

        <Section title="2. Accounts">
          <p>
            Some features require an account. You are responsible for the information you provide and
            for keeping your login credentials secure. You must be at least 13 years old to create an
            account. You are responsible for all activity that occurs under your account.
          </p>
        </Section>

        <Section title="3. Subscriptions, billing, and refunds">
          <p>
            Paid subscriptions are billed through our payment processor, Stripe. By subscribing, you
            authorize us (via Stripe) to charge your payment method on a recurring basis at the price
            and interval shown at checkout, until you cancel.
          </p>
          <p>
            Subscriptions renew automatically. You can cancel anytime from your account or by emailing
            us; cancellation stops future renewals and your access continues through the end of the
            current paid period. Except where required by law, payments are non-refundable and we do
            not provide refunds or credits for partial periods. Prices may change, with notice for
            renewals.
          </p>
        </Section>

        <Section title="4. Acceptable use">
          <p>You agree not to:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>scrape, crawl, or use automated means to access or copy the Service or its data;</li>
            <li>resell, redistribute, or publicly republish data, analytics, or content from the Service;</li>
            <li>share, resell, or circumvent access to paid features, or share a paid account;</li>
            <li>reverse engineer, disrupt, or attempt to gain unauthorized access to the Service; or</li>
            <li>use the Service in any unlawful way or in violation of others&rsquo; rights.</li>
          </ul>
        </Section>

        <Section title="5. Intellectual property">
          <p>
            The underlying box-score and game statistics are facts compiled from public sources and are
            not owned by us. Our original analytics, metrics, compilations, graphics, written content,
            and software, along with the &ldquo;NW Baseball Stats&rdquo; name and branding, are owned by
            us and protected by applicable law. We grant you a limited, personal, non-transferable
            license to use the Service for your own non-commercial use, subject to these Terms.
          </p>
        </Section>

        <Section title="6. Data sources and no affiliation">
          <p>
            NW Baseball Stats is an independent project. It is not affiliated with, endorsed by, or
            sponsored by the NCAA, NAIA, NWAC, any conference, league, school, or team. Team names,
            logos, and marks belong to their respective owners. Statistics are aggregated from publicly
            available sources and may contain errors, omissions, or delays.
          </p>
        </Section>

        <Section title="7. Disclaimers">
          <p>
            The Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without
            warranties of any kind, express or implied. We do not warrant that the data is accurate,
            complete, current, or error-free, or that the Service will be uninterrupted. The Service is
            for informational and entertainment purposes and should not be relied on as the sole basis
            for any decision.
          </p>
        </Section>

        <Section title="8. Limitation of liability">
          <p>
            To the fullest extent permitted by law, we will not be liable for any indirect, incidental,
            special, consequential, or punitive damages, or for any loss arising from your use of (or
            inability to use) the Service. Our total liability for any claim relating to the Service
            will not exceed the amount you paid us in the twelve months before the claim.
          </p>
        </Section>

        <Section title="9. Termination">
          <p>
            You may stop using the Service at any time. We may suspend or terminate your access if you
            violate these Terms or use the Service in a way that could harm us or others. Sections that
            by their nature should survive termination will survive.
          </p>
        </Section>

        <Section title="10. Changes to these Terms">
          <p>
            We may update these Terms from time to time. When we do, we will revise the &ldquo;Last
            updated&rdquo; date above. Your continued use of the Service after changes take effect means
            you accept the updated Terms.
          </p>
        </Section>

        <Section title="11. Contact">
          <p>
            Questions about these Terms? Email{' '}
            <a href={`mailto:${CONTACT}`} className="text-nw-teal dark:text-teal-400 font-semibold hover:underline">{CONTACT}</a>.
          </p>
        </Section>
      </div>
    </div>
  )
}
