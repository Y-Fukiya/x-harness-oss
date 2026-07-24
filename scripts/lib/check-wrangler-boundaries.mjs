export function validateWranglerBoundaries(wrangler) {
  const violations = [];
  const productionMatch = wrangler.match(
    /^\[env\.production\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m,
  );
  if (productionMatch) {
    const productionSection = productionMatch[1];
    if (!/^workers_dev\s*=\s*false\s*$/m.test(productionSection)) {
      violations.push('apps/worker/wrangler.toml: env.production must disable workers.dev');
    }
    if (!/^preview_urls\s*=\s*false\s*$/m.test(productionSection)) {
      violations.push('apps/worker/wrangler.toml: env.production must disable preview URLs');
    }
    const productionCustomDomains = [
      ...productionSection.matchAll(
        /\{\s*pattern\s*=\s*"[^"]+"\s*,\s*custom_domain\s*=\s*true\s*\}/g,
      ),
    ];
    if (productionCustomDomains.length !== 1) {
      violations.push('apps/worker/wrangler.toml: env.production must configure one custom API domain');
    }
  }
  if (productionMatch) {
    for (const binding of ['AUTH_RATE_LIMITER', 'PUBLIC_ACTION_RATE_LIMITER']) {
      const configured = new RegExp(
        `\\[\\[env\\.production\\.ratelimits\\]\\][\\s\\S]*?^name\\s*=\\s*"${binding}"$`,
        'm',
      ).test(wrangler);
      if (!configured) {
        violations.push(`apps/worker/wrangler.toml: env.production must bind ${binding}`);
      }
    }
  }
  const environmentVariables = [...wrangler.matchAll(
    /^\[env\.([^.]+)\.vars\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm,
  )].map((match) => {
    const values = Object.fromEntries(
      [...match[2].matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/gm)]
        .map((entry) => [entry[1], entry[2]]),
    );
    return { environment: match[1], values };
  });
  if (environmentVariables.length === 0) {
    violations.push('apps/worker/wrangler.toml: no environment variable tables were found');
  }
  for (const { environment, values } of environmentVariables) {
    const prefix = `apps/worker/wrangler.toml: env.${environment}`;
    if (values.CUBELIC_SAFE_MODE !== 'true') {
      violations.push(`${prefix} must keep CUBELIC_SAFE_MODE=true`);
    }
    if (values.CUBELIC_HUMAN_INTERACTIONS_ENABLED === 'true') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(values.INTERACTION_FINGERPRINT_KEY_VERSION ?? '')) {
        violations.push(`${prefix} named-human interactions require an explicit fingerprint key version`);
      }
      const stagingInteractionSmoke = environment === 'staging'
        && values.CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE === 'true'
        && values.CUBELIC_PHASE3_DELIVERY_MODE === 'staging_fake';
      const verifiedInteractionRelease = values.HUMAN_INTERACTIONS_RELEASE_APPROVED === 'true'
        && values.STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED === 'true';
      if (!stagingInteractionSmoke && !verifiedInteractionRelease) {
        violations.push(`${prefix} named-human interactions require release approval and verified staging smoke`);
      }
      if (values.GLOBAL_PUBLISHING_DISABLED !== 'false') {
        violations.push(`${prefix} named-human interactions require GLOBAL_PUBLISHING_DISABLED=false`);
      }
    } else if (
      values.CUBELIC_HUMAN_INTERACTIONS_ENABLED !== 'false'
      || values.CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE !== 'false'
      || values.HUMAN_INTERACTIONS_RELEASE_APPROVED !== 'false'
      || values.STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED !== 'false'
    ) {
      violations.push(`${prefix} disabled named-human interactions must keep all interaction gates false`);
    }
    if (environment === 'production' && values.CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE !== 'false') {
      violations.push(`${prefix} production must disable named-human interaction smoke mode`);
    }
    const hasInteractionWatchConfig = [
      'X_INTERACTION_WATCH_ENABLED',
      'X_INTERACTION_WATCH_SMOKE_MODE',
      'X_INTERACTION_WATCH_RELEASE_APPROVED',
      'X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED',
      'X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED',
      'X_INTERACTION_WATCH_PRIVACY_REVIEW_ID',
      'X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID',
    ].some((key) => Object.hasOwn(values, key));
    const interactionWatchEnabled = values.X_INTERACTION_WATCH_ENABLED === 'true';
    if (hasInteractionWatchConfig) {
      if (interactionWatchEnabled) {
        const stagingWatchSmoke = environment === 'staging'
          && values.X_INTERACTION_WATCH_SMOKE_MODE === 'true';
        const verifiedWatchRelease = values.X_INTERACTION_WATCH_RELEASE_APPROVED === 'true'
          && values.X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED === 'true';
        if (!stagingWatchSmoke && !verifiedWatchRelease) {
          violations.push(`${prefix} interaction watches require release approval and verified staging smoke`);
        }
        if (values.GLOBAL_PUBLISHING_DISABLED !== 'false') {
          violations.push(`${prefix} interaction watches require GLOBAL_PUBLISHING_DISABLED=false`);
        }
        if (
          values.CUBELIC_PHASE3_ENABLED === 'true'
          || values.CUBELIC_HUMAN_INTERACTIONS_ENABLED === 'true'
        ) {
          violations.push(`${prefix} interaction watches must be isolated from every X-write release`);
        }
        if (
          values.X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED !== 'true'
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(
            values.X_INTERACTION_WATCH_PRIVACY_REVIEW_ID ?? '',
          )
          || !/^[1-9][0-9]{4,29}$/.test(
            values.X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID ?? '',
          )
        ) {
          violations.push(`${prefix} interaction watches require privacy evidence bound to one X user id`);
        }
      } else if (
        values.X_INTERACTION_WATCH_ENABLED !== 'false'
        || values.X_INTERACTION_WATCH_SMOKE_MODE !== 'false'
        || values.X_INTERACTION_WATCH_RELEASE_APPROVED !== 'false'
        || values.X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED !== 'false'
        || values.X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED !== 'false'
        || values.X_INTERACTION_WATCH_PRIVACY_REVIEW_ID !== ''
        || values.X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID !== ''
      ) {
        violations.push(`${prefix} disabled interaction watches must keep all watch gates false`);
      }
      if (
        environment === 'production'
        && values.X_INTERACTION_WATCH_SMOKE_MODE !== 'false'
      ) {
        violations.push(`${prefix} production must disable interaction watch smoke mode`);
      }
    }
    if (values.CUBELIC_PHASE3_ENABLED === 'true') {
      if (values.GLOBAL_PUBLISHING_DISABLED !== 'false') {
        violations.push(`${prefix} Phase 3 requires GLOBAL_PUBLISHING_DISABLED=false`);
      }
      if (values.PHASE3_RELEASE_APPROVED !== 'true' || values.STAGING_PHASE3_SMOKE_VERIFIED !== 'true') {
        violations.push(`${prefix} Phase 3 requires release approval and verified staging smoke`);
      }
      const expectedDeliveryMode = environment === 'staging' ? 'staging_fake' : 'x';
      if (values.CUBELIC_PHASE3_DELIVERY_MODE !== expectedDeliveryMode) {
        violations.push(`${prefix} Phase 3 delivery mode must be ${expectedDeliveryMode}`);
      }
      const policies = (values.CUBELIC_PHASE3_SCHEDULE_POLICIES ?? '')
        .split(',')
        .map((policy) => policy.trim())
        .filter(Boolean);
      if (policies.length === 0 || policies.some((policy) => !/^(event_notice|event_reminder|youtube_notice):[A-Za-z0-9_-]+$/.test(policy))) {
        violations.push(`${prefix} Phase 3 schedule policies must be explicit reviewed category:template_id pairs`);
      }
      if (
        environment === 'staging'
        && values.WORKER_URL !== 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev'
      ) {
        violations.push(`${prefix} staging_fake delivery requires the exact dedicated staging Worker URL`);
      }
      if (values.CUBELIC_PHASE3_MEDIA_ENABLED === 'true') {
        const stagingSmokeMode = environment === 'staging'
          && values.CUBELIC_PHASE3_MEDIA_SMOKE_MODE === 'true';
        const verifiedRelease = values.STAGING_PHASE3_MEDIA_SMOKE_VERIFIED === 'true'
          && values.MEDIA_RETENTION_POLICY_VERIFIED === 'true';
        if (!stagingSmokeMode && !verifiedRelease) {
          violations.push(`${prefix} media delivery requires verified media smoke and retention policy`);
        }
        const mediaBinding = new RegExp(
          `\\[\\[env\\.${environment}\\.r2_buckets\\]\\][\\s\\S]*?^binding\\s*=\\s*"CUBELIC_MEDIA"$`,
          'm',
        ).test(wrangler);
        if (!mediaBinding) {
          violations.push(`${prefix} media delivery requires the dedicated CUBELIC_MEDIA R2 binding`);
        }
      } else if (values.CUBELIC_PHASE3_MEDIA_ENABLED !== 'false') {
        violations.push(`${prefix} must set CUBELIC_PHASE3_MEDIA_ENABLED to true or false exactly`);
      } else if (
        values.CUBELIC_PHASE3_MEDIA_SMOKE_MODE !== 'false'
        ||
        values.STAGING_PHASE3_MEDIA_SMOKE_VERIFIED !== 'false'
        || values.MEDIA_RETENTION_POLICY_VERIFIED !== 'false'
      ) {
        violations.push(`${prefix} disabled media delivery must keep media verification flags false`);
      }
      if (environment === 'production' && values.CUBELIC_PHASE3_MEDIA_SMOKE_MODE !== 'false') {
        violations.push(`${prefix} production must disable media smoke mode`);
      }
    } else {
      if (values.CUBELIC_PHASE3_ENABLED !== 'false') {
        violations.push(`${prefix} must set CUBELIC_PHASE3_ENABLED to true or false exactly`);
      }
      if (!interactionWatchEnabled && values.GLOBAL_PUBLISHING_DISABLED !== 'true') {
        violations.push(`${prefix} Phase 1 requires GLOBAL_PUBLISHING_DISABLED=true`);
      }
      if (values.CUBELIC_PHASE3_MEDIA_ENABLED !== 'false') {
        violations.push(`${prefix} Phase 1 requires CUBELIC_PHASE3_MEDIA_ENABLED=false`);
      }
    }
  }
  return violations;
}
