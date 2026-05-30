// /summer/teams — grid of all WCL clubs, grouped by division.
import SummerPageShell from './SummerPageShell'
import { Teams } from '../SummerHub'

export default function SummerTeamsPage() {
  return (
    <SummerPageShell
      title="WCL Teams"
      subtitle="Click any team to see record, roster, recent games, and leaders."
    >
      <Teams />
    </SummerPageShell>
  )
}
