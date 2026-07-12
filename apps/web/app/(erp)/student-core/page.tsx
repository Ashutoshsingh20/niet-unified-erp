import type { Metadata } from 'next';
import { StudentCoreWorkspace } from '@/components/student-core-workspace';
export const metadata: Metadata = { title: 'My student record' };
export default function StudentCorePage(): React.ReactNode {
  return <><header className="page-header"><div><h1>My student record</h1>
    <p>Live registration, schedule, attendance evidence, and account balance from NIET systems of record.</p>
  </div></header><StudentCoreWorkspace /></>;
}
