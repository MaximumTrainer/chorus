/**
 * The landing page.
 *
 * Deliberately almost empty. What belongs here — a workspace's documents,
 * tasks and sessions — is WP-1.6 and WP-1.7; putting a plausible-looking
 * dashboard here now would be a screen nobody had a requirement for, and the
 * first thing to be thrown away.
 */
export default function Home(): JSX.Element {
  return (
    <main>
      <h1>Chorus</h1>
      <p>Open a document to start.</p>
    </main>
  )
}
