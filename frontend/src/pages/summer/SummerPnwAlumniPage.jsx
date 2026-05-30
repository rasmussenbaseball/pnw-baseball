// /summer/pnw-alumni — spring PNW college players currently rostered in WCL.
import SummerPageShell from './SummerPageShell'
import { PnwAlumni } from '../SummerHub'

export default function SummerPnwAlumniPage() {
  return (
    <SummerPageShell
      title="PNW Alumni in the WCL"
      subtitle="Every linked college player on a WCL roster this summer, grouped by school."
    >
      <PnwAlumni />
    </SummerPageShell>
  )
}
