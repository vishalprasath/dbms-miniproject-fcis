import './globals.css';

export const metadata = {
  title: 'FCIS - Financial Commitment Intelligence System',
  description: 'Early detection of cash-flow shortfalls from recurring financial commitments.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
