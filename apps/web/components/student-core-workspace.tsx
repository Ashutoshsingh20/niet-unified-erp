'use client';
import { useQuery } from '@tanstack/react-query';
import { erpRequest } from '@/lib/client-api';

interface Overview {
  student: { id: string; displayName: string; status: string };
  programmes: { enrolmentId: string; programmeKey: string; programmeTitle: string;
    programmeVersion: number; regulationKey: string; regulationVersion: number;
    status: string; startsOn: string; endsOn: string | null }[];
  holds: { holdId: string; holdKey: string; effect: string; reason: string;
    status: string; raisedAt: string }[];
  registrations: { requestId: string; periodTitle: string; offeringId: string;
    offeringTitle: string; courseKey: string }[];
  schedule: { meetingId: string; offeringTitle: string; courseKey: string;
    weekday: number; startMinute: number; endMinute: number; roomKey: string }[];
  attendance: { sessionId: string; offeringTitle: string; courseKey: string;
    presenceState: string; observedAt: string }[];
  accounts: { accountId: string; currency: string; balanceMinor: string }[];
}
const weekdays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
export function StudentCoreWorkspace(): React.ReactNode {
  const overview = useQuery({ queryKey: ['student-core-me'], queryFn: () => erpRequest<Overview>('v1/student-core/me') });
  if (overview.isLoading) return <div className="panel" role="status"><div className="loading-lines"><span /><span /><span /></div></div>;
  if (overview.isError || overview.data === undefined) return <div className="error-banner" role="alert">
    Your canonical student record is unavailable, ambiguous, or outside your current access. Contact the registrar rather than creating another record.
  </div>;
  const data = overview.data;
  return <div>
    <section className="summary-grid" aria-label="Student record summary">
      <div className="summary"><div className="summary-label">Student</div><div className="summary-value summary-value-small">{data.student.displayName}</div></div>
      <div className="summary"><div className="summary-label">Record status</div><div className="summary-value summary-value-small">{humanize(data.student.status)}</div></div>
      <div className="summary"><div className="summary-label">Confirmed courses</div><div className="summary-value">{data.registrations.length}</div></div>
      <div className="summary"><div className="summary-label">Active holds</div><div className="summary-value">{data.holds.filter((item) => item.status === 'ACTIVE').length}</div></div>
    </section>
    <section className="panel" aria-labelledby="programme-heading"><div className="panel-header"><h2 id="programme-heading">Programme and curriculum</h2></div>
      <Rows empty="No programme enrolment is assigned." rows={data.programmes.map((item) => ({ id: item.enrolmentId,
        title: `${item.programmeKey} · ${item.programmeTitle}`,
        detail: `Programme v${item.programmeVersion} · ${item.regulationKey} v${item.regulationVersion} · ${humanize(item.status)} · ${item.startsOn}${item.endsOn === null ? ' onward' : ` to ${item.endsOn}`}` }))} /></section>
    <section className="panel" aria-labelledby="holds-heading"><div className="panel-header"><h2 id="holds-heading">Holds</h2></div>
      <Rows empty="No hold history." rows={data.holds.map((item) => ({ id: item.holdId,
        title: `${item.holdKey} · ${humanize(item.status)}`,
        detail: `${humanize(item.effect)} · ${item.reason} · raised ${new Date(item.raisedAt).toLocaleString()}` }))} />
      <div className="panel-body"><p className="help">Only explicitly approved active effects are enforced. Balances and attendance never create hidden holds.</p></div></section>
    <div className="two-column">
      <section className="panel" aria-labelledby="schedule-heading"><div className="panel-header"><h2 id="schedule-heading">Published schedule</h2></div>
        <Rows empty="No published meetings for confirmed registrations." rows={data.schedule.map((item) => ({
          id: item.meetingId, title: `${item.courseKey} · ${item.offeringTitle}`,
          detail: `${weekdays[item.weekday - 1] ?? 'Unknown day'}, ${clock(item.startMinute)}–${clock(item.endMinute)} · ${item.roomKey}` }))} /></section>
      <section className="panel" aria-labelledby="account-heading"><div className="panel-header"><h2 id="account-heading">Student accounts</h2></div>
        <Rows empty="No student account is linked." rows={data.accounts.map((item) => ({ id: item.accountId,
          title: item.currency, detail: `${item.balanceMinor} minor units receivable` }))} />
        <div className="panel-body"><p className="help">Balances are derived from immutable ledger entries. Currency display rules remain subject to approved finance policy.</p></div></section>
    </div>
    <section className="panel" aria-labelledby="registration-heading"><div className="panel-header"><h2 id="registration-heading">Confirmed registration</h2></div>
      <Rows empty="No confirmed registration." rows={data.registrations.map((item) => ({ id: `${item.requestId}:${item.offeringId}`,
        title: `${item.courseKey} · ${item.offeringTitle}`, detail: item.periodTitle }))} /></section>
    <section className="panel" aria-labelledby="attendance-heading"><div className="panel-header"><h2 id="attendance-heading">Finalized attendance evidence</h2></div>
      <Rows empty="No finalized attendance evidence." rows={data.attendance.map((item) => ({ id: item.sessionId,
        title: `${item.courseKey} · ${item.offeringTitle}`, detail: `${humanize(item.presenceState)} · observed ${new Date(item.observedAt).toLocaleString()}` }))} />
      <div className="panel-body"><p className="help">This shows recorded evidence and approved corrections. Academic consequences are not inferred here.</p></div></section>
  </div>;
}
function Rows({ rows, empty }: { rows: { id: string; title: string; detail: string }[]; empty: string }): React.ReactNode {
  return rows.length === 0 ? <div className="empty-state">{empty}</div> : <ul className="data-list">{rows.map((row) =>
    <li key={row.id}><div className="item-title">{row.title}</div><div className="item-meta"><span>{row.detail}</span></div></li>)}</ul>;
}
function clock(minute: number): string { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; }
function humanize(value: string): string { return value.toLowerCase().replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()); }
