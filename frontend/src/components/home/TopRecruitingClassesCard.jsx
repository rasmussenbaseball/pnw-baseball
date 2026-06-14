// Public teaser: top 2026 recruiting classes. Uses the shared homepage
// WidgetCard shell so it matches the rest of the widget grid. Fed by the
// PUBLIC /recruiting/classes/top endpoint, so logged-out visitors see it
// and can click through to the (premium) full leaderboard.
import { useTopRecruitingClasses } from '../../hooks/useApi'
import { WidgetCard, PlayerRow, WidgetSkeleton, WidgetNote } from './WidgetShell'

export default function TopRecruitingClassesCard({ gradYear = 2026, limit = 5, className = '' }) {
  const { data, loading, error } = useTopRecruitingClasses(gradYear, limit)
  const classes = data?.classes || []

  return (
    <WidgetCard
      title={`Top ${gradYear} Recruiting Classes`}
      to="/recruiting-classes"
      linkLabel="Full board"
      accent="teal"
      badge="HS commits"
      className={className}
    >
      {loading && <WidgetSkeleton rows={limit} />}
      {error && <WidgetNote>Couldn't load recruiting classes.</WidgetNote>}
      {!loading && !error && classes.length === 0 && (
        <WidgetNote>No commits yet.</WidgetNote>
      )}
      {!loading && !error && classes.map((cls, i) => (
        <PlayerRow
          key={cls.team_id}
          rank={cls.class_rank ?? i + 1}
          logo={cls.logo_url}
          name={cls.short_name || cls.name}
          sub={`${cls.commits} commit${cls.commits === 1 ? '' : 's'} · ${cls.ranked} ranked`}
          value={Math.round(cls.class_score)}
          to="/recruiting-classes"
        />
      ))}
    </WidgetCard>
  )
}
