import RequirePageAccess from '@/components/RequirePageAccess';

/**
 * Route guard for Settings > Users & Teams, which follows the "Show Users & Teams page" switch. That switch is display
 * only (the server never checks it), so it is read from the person's own resolved switches rather than from a rule.
 * Anyone refused is sent to their dashboard.
 */
export default function RequireUsersTeamsPage() {
  return <RequirePageAccess all={['show_users_teams_page']} />;
}
