import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import LoginForm from './LoginForm';

export default async function LoginPage() {
  if (await getSession()) redirect('/');
  return (
    <div className="login-wrap">
      <div className="login-art">
        <div className="brand">
          <div className="brand-mark">FC</div>
          <div>
            <div className="brand-name">FCIS</div>
            <div className="brand-sub">Financial Commitment Intelligence System</div>
          </div>
        </div>
        <h1>See the cash-flow shortfall before it happens.</h1>
        <p>
          FCIS tracks every recurring payment and expected receipt, projects each bank account day by day,
          and raises an alert when the balance is about to fall below its safe level.
        </p>
        <ul>
          <li>Commitments expand into instalments automatically</li>
          <li>Receipts are weighted by how reliably each customer pays</li>
          <li>Each alert comes with the payments that can be deferred to close the gap</li>
        </ul>
      </div>
      <div className="login-pane">
        <div className="login-box">
          <h2>Sign in</h2>
          <p className="muted" style={{ marginBottom: 18 }}>Kaveri Print Works Pvt Ltd</p>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
