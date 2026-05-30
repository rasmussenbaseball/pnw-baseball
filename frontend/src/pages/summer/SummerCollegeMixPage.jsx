// /summer/college-mix — most-represented colleges in the WCL.
import SummerPageShell from './SummerPageShell'
import { CollegeMix } from '../SummerHub'

export default function SummerCollegeMixPage() {
  return (
    <SummerPageShell
      title="College Representation"
      subtitle="Which colleges have the most players in the WCL this summer."
    >
      <CollegeMix />
    </SummerPageShell>
  )
}
