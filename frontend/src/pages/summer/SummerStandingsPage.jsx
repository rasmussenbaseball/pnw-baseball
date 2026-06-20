// /summer/standings — combined standings + Composite Power Index (the old
// /summer/cpi page folded in here, since both rank the same teams).
import SummerPageShell from './SummerPageShell'
import { Standings } from '../SummerHub'
import PowerIndexTable from './SummerPowerIndex'

export default function SummerStandingsPage() {
  return (
    <SummerPageShell
      title="WCL Standings & Power Index"
      subtitle="Division standings (L10 = last 10 games, Streak = current run) plus the predictive Composite Power Index."
    >
      <Standings />

      <div className="mt-8">
        <h2 className="text-lg font-black text-nw-teal dark:text-gray-100 mb-2">Composite Power Index</h2>
        <PowerIndexTable />
      </div>
    </SummerPageShell>
  )
}
