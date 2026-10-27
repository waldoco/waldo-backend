// The Vault holds what Waldo may one day use on your behalf: sign-ins and payments. Neither exists yet, so the page reads
// nothing and claims nothing is stored.
export function VaultPanel() {
  return <div className="vault-page">
    <div className="page-heading"><h1>Vault.</h1><p>Passwords and payments Waldo can use for you.</p></div>
    <section className="panel" aria-labelledby="vault-passwords-title">
      <div className="vault-head"><h2 id="vault-passwords-title">Passwords</h2><span className="access-label">Coming soon</span></div>
      <h3>Sign-ins Waldo can use for you</h3>
      <p>Nothing is stored here yet. When this arrives, each sign-in you save is encrypted, used only on its own website, and never shown to Waldo’s model.</p>
    </section>
    <section className="panel" aria-labelledby="vault-payments-title">
      <div className="vault-head"><h2 id="vault-payments-title">Payments</h2><span className="access-label">Coming later</span></div>
      <p>Nothing is stored here yet.</p>
    </section>
  </div>;
}
