// /summer/standings — full standings (W/L, L10, streak, RS/RA), grouped by division.
import SummerPageShell from './SummerPageShell'
import { Standings } from '../SummerHub'

export default function SummerStandingsPage() {
  return (
    <SummerPageShell
      title="WCL Standings"
      subtitle="North + South division. L10 = last 10 games. Streak shows current run."
    >
      <Standings />
    </SummerPageShell>
  )
}
