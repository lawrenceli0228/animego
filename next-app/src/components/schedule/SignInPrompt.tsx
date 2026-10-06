// What a visitor sees where a signed-in reader sees 我追的 · 本周: one line on
// what signing in adds to this page, and the way in. Server component — the
// page already knows the visitor is anonymous, so nothing here probes auth.

import Link from "@/components/ui/LocaleLink";
import type { Dict } from "@/lib/i18n";
import styles from "./aside.module.css";

interface SignInPromptProps {
  dict: Dict;
  /** /login, carrying ?from= back to this page. */
  loginHref: string;
}

export default function SignInPrompt({ dict, loginHref }: SignInPromptProps) {
  return (
    <section className={`${styles.box} ${styles.prompt}`} aria-labelledby="schedule-signin">
      <h3 id="schedule-signin" className={styles.title}>
        {dict.schedule.signInTitle}
      </h3>
      <p className={styles.body}>{dict.schedule.signInBody}</p>
      <Link href={loginHref} prefetch={false} className={styles.cta}>
        {dict.nav.login}
      </Link>
    </section>
  );
}
