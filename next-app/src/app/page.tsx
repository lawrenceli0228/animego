import "@/components/landing/shared/motion.css";
import StatsRow from "@/components/landing/StatsRow";
import { getDict } from "@/lib/i18n";

// LandingPage is the RSC entry for "/". It server-fetches data (trending,
// detail posters) and forwards typed dicts + data into client landing
// sections. Phase 4.1 wires StatsRow only; other sections (HeroSection,
// FeaturesBento, etc.) land via parallel subagents in P4.1.1.

export default async function LandingPage() {
  const dict = await getDict();

  return (
    <main>
      <StatsRow dict={dict} />
    </main>
  );
}
