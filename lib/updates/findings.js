/**
 * From a Renovate report to findings: one per (dependency, current → target), merged across every
 * file it is pinned in, each with a policy (silent, ask, hold) and the edits that would apply it.
 * Pure, apart from resolvePins, which asks Docker for the digest that runs.
 */

import {daysBetween, idOf, parseRef, versionOf} from './refs.js';

/** The first config rule that covers a finding, if any. */
export function ruleFor(cfg, base) {
    for (const r of cfg.rules ?? []) {
        if (r.manager && r.manager !== base.manager) continue;
        if (r.updateTypes && !r.updateTypes.includes(base.updateType)) continue;
        if (r.match && !new RegExp(r.match, 'i').test(base.name)) continue;
        return r;
    }
    return null;
}

/**
 * The policy of a finding: silent (applied by itself), ask (a proposal), hold (listed). `waiting`
 * is a silent one whose release is too young.
 */
export function decidePolicy(cfg, base) {
    const rule = ruleFor(cfg, base);
    if (rule) return {policy: rule.policy, reason: rule.why, waiting: false, byRule: true};
    if (base.kind === 'package') {
        if (base.inRange) {
            const waiting = base.ageDays !== null && base.ageDays < cfg.minimumReleaseAgeDays;
            return {
                policy: 'silent',
                reason: "inside the declared range: refreshed with the service's other packages",
                waiting,
            };
        }
        if (base.updateType === 'major') {
            return {
                policy: 'ask',
                reason: 'major version: breaking changes are expected, and the range has to change with it',
                waiting: false,
            };
        }
        return {
            policy: 'ask',
            reason: 'outside the declared range (a minor of a 0.x package, which may break): the range has to change with it',
            waiting: false,
        };
    }
    if (base.updateType === 'pinDigest' || base.updateType === 'digest') {
        if (!cfg.digests) return {policy: 'hold', reason: 'digest pinning is switched off (`digests`)', waiting: false};
        return base.updateType === 'pinDigest'
            ? {policy: 'silent', reason: 'pin to the image that runs now: the same bits, one restart', waiting: false}
            : {
                  policy: 'silent',
                  reason: `the same version, rebuilt upstream; at most one such refresh per image in ${cfg.digestIntervalDays} days`,
                  waiting: false,
              };
    }
    if (base.updateType === 'patch') {
        if (base.ageDays !== null && base.ageDays < cfg.minimumReleaseAgeDays) {
            return {
                policy: 'silent',
                reason: `patch step, waiting until the release is ${cfg.minimumReleaseAgeDays} days old`,
                waiting: true,
            };
        }
        return {
            policy: 'silent',
            reason:
                base.ageDays === null
                    ? `patch step; the registry gives no release date, so it waits until it has been listed for ${cfg.minimumReleaseAgeDays} days`
                    : `patch step on a pinned version${base.behindDays !== null ? `, ${base.behindDays} day(s) behind` : ''}`,
            waiting: false,
        };
    }
    if (base.kind === 'unpinned') {
        return {
            policy: 'ask',
            reason: 'floats on a moving tag: nothing can tell whether it is current, and every pull may be a different version',
            waiting: false,
        };
    }
    if (base.updateType === 'major' || base.isBreaking)
        return {policy: 'ask', reason: 'major version: breaking changes are expected', waiting: false};
    // With an assessor, no minor goes by its age alone: the hook reads the release notes first.
    if (cfg.hooks?.assessor && base.updateType === 'minor') {
        return {
            policy: 'ask',
            reason: 'minor step: a person decides, unless the assessor finds the release notes clean and the service keeps no data',
            waiting: false,
        };
    }
    if (base.updateType === 'minor' && base.newMajor === 0)
        return {policy: 'ask', reason: '0.x release: a minor step may break', waiting: false};
    if (base.updateType !== 'minor' && base.updateType !== 'patch') {
        return {
            policy: 'ask',
            reason: `update type "${base.updateType}" is not one stacktender applies on its own`,
            waiting: false,
        };
    }
    if (base.behindDays === null)
        return {policy: 'ask', reason: 'cannot tell how far behind the running version is', waiting: false};
    if (base.behindDays > cfg.maxCatchUpDays) {
        return {
            policy: 'ask',
            reason: `catch-up of about ${Math.round(base.behindDays / 30)} month(s): services that migrate their data forward may not survive a rollback`,
            waiting: false,
        };
    }
    if (base.ageDays !== null && base.ageDays < cfg.minimumReleaseAgeDays) {
        return {
            policy: 'silent',
            reason: `${base.updateType} step, waiting until the release is ${cfg.minimumReleaseAgeDays} days old`,
            waiting: true,
        };
    }
    return {
        policy: 'silent',
        reason: `${base.updateType} step on a pinned version, ${base.behindDays} day(s) behind`,
        waiting: false,
    };
}

/** Services running this image at this tag, whatever digest their pin carries. */
export function servicesFor(services, name, tag) {
    const names = Object.entries(services)
        .filter(([, s]) => {
            if (!s.image) return false;
            const ref = parseRef(s.image);
            return ref.name === name && ref.tag === tag;
        })
        .map(([n]) => n);
    return {names, owners: [...new Set(names.map((n) => services[n].owner ?? 'root'))]};
}

/** Services built from a Dockerfile's directory (chat/Dockerfile → the chat service). */
export function buildServicesFor(services, packageFile) {
    const parts = packageFile.split('/');
    if (!/^Dockerfile/i.test(parts[parts.length - 1])) return [];
    return Object.keys(services).includes(parts[0]) ? [parts[0]] : [];
}

/**
 * One edit per place the reference stands: `name:current` there becomes `name:target`, tag and
 * digest together. None at all when one place does not hold the expected text: half a change is
 * worse than a finding that needs a person.
 */
export function editsFor(item, current, target) {
    const oldRef = `${item.name}:${current}`;
    const newRef = `${item.name}:${target}`;
    const edits = [];
    for (const place of item.places ?? []) {
        if (!place.text.includes(oldRef)) return [];
        edits.push({file: place.file, find: place.text, replace: place.text.replace(oldRef, newRef), wholeToken: true});
    }
    return edits;
}

/**
 * The findings from a Renovate report.
 * @param {object} report Renovate's JSON report (`repositories.local.packageFiles`)
 * @param {object} services compose services: {name: {image, owner}}
 * @param {object} cfg
 * @param {{refreshHeld?: Record<string, string>}} [extra]
 */
export function buildItems(report, services, cfg, {refreshHeld = {}} = {}) {
    const packageFiles = report?.repositories?.local?.packageFiles ?? {};
    const grouped = new Map();
    const unpinned = new Map();

    const pkgServices = {};
    for (const manager of ['npm', 'bun']) {
        for (const f of packageFiles[manager] ?? []) {
            if (!Array.isArray(f.lockFiles) || f.lockFiles.length === 0 || !String(f.packageFile).includes('/'))
                continue;
            pkgServices[String(f.packageFile).split('/')[0]] = {
                manager,
                blind: !(f.deps ?? []).some((d) => d.lockedVersion),
            };
        }
    }

    // Every place an image is pinned gets every finding known for that image: the scanners of the
    // compose file and the Dockerfiles give digests and pin findings, others give versions at most.
    const findings = new Map();
    const imageKey = (dep) => `${dep.depName}|${dep.currentValue}|${dep.currentDigest ?? ''}`;
    for (const files of Object.values(packageFiles)) {
        for (const f of files) {
            for (const dep of f.deps ?? []) {
                if (dep.datasource !== 'docker' || !dep.depName || !dep.currentValue || dep.skipReason) continue;
                const known = findings.get(imageKey(dep)) ?? new Map();
                findings.set(imageKey(dep), known);
                for (const u of dep.updates ?? []) {
                    const key = `${u.updateType}|${u.newValue ?? dep.currentValue}`;
                    const have = known.get(key);
                    known.set(key, {...have, ...u, newDigest: u.newDigest ?? have?.newDigest});
                }
            }
        }
    }

    for (const [manager, files] of Object.entries(packageFiles)) {
        for (const f of files) {
            for (const dep of f.deps ?? []) {
                const name = dep.depName ?? '';
                if (!name) continue;
                const isDocker = dep.datasource === 'docker';
                const isPackage = manager === 'npm' || manager === 'bun';
                const kind = isPackage ? 'package' : manager === 'dockerfile' ? 'base-image' : 'image';
                const declared = versionOf(dep.currentValue, dep.currentDigest);

                if (isDocker && (!dep.currentValue || dep.skipReason === 'invalid-value')) {
                    const key = `${name}:${dep.currentValue ?? '(no tag)'}`;
                    const existing = unpinned.get(key);
                    if (existing) {
                        if (!existing.files.includes(f.packageFile)) existing.files.push(f.packageFile);
                        continue;
                    }
                    const svc =
                        manager === 'dockerfile'
                            ? {names: buildServicesFor(services, f.packageFile), owners: ['root']}
                            : servicesFor(services, name, dep.currentValue ?? '');
                    const d = decidePolicy(cfg, {
                        kind: 'unpinned',
                        name,
                        manager,
                        updateType: 'unversioned',
                        ageDays: null,
                        behindDays: null,
                    });
                    unpinned.set(key, {
                        id: idOf('unpinned', name, dep.currentValue ?? ''),
                        kind: 'unpinned',
                        name,
                        files: [f.packageFile],
                        current: dep.currentValue ?? '(no tag)',
                        target: null,
                        updateType: 'unversioned',
                        released: null,
                        ageDays: null,
                        behindDays: null,
                        sourceUrl: dep.sourceUrl ?? null,
                        services: svc.names,
                        owners: svc.owners,
                        policy: d.policy,
                        reason: d.reason,
                        edits: [],
                        state: 'pending',
                    });
                    continue;
                }
                if (dep.skipReason) continue;

                const updates = isDocker ? [...(findings.get(imageKey(dep))?.values() ?? [])] : (dep.updates ?? []);
                for (const u of updates) {
                    const updateType = String(u.updateType ?? 'unknown');
                    const newValue = String(u.newValue ?? dep.currentValue ?? '');
                    // While digests are off, an image without one stays without one.
                    const newDigest =
                        isDocker && (cfg.digests || dep.currentDigest || updateType === 'pinDigest')
                            ? (u.newDigest ?? null)
                            : null;
                    const inRange = isPackage && u.isLockfileUpdate === true && !!dep.lockedVersion && !!u.newVersion;
                    const current = inRange ? String(dep.lockedVersion) : declared;
                    const target = isDocker
                        ? versionOf(newValue, newDigest)
                        : inRange
                          ? String(u.newVersion)
                          : newValue;
                    if (!target || target === current) continue;
                    const key = `${kind}|${name}|${current}|${target}`;
                    const place =
                        isDocker && typeof dep.replaceString === 'string'
                            ? {file: f.packageFile, text: dep.replaceString}
                            : null;
                    const existing = grouped.get(key);
                    if (existing) {
                        if (!existing.files.includes(f.packageFile)) existing.files.push(f.packageFile);
                        if (place && !existing.places.some((p) => p.file === place.file && p.text === place.text))
                            existing.places.push(place);
                        for (const s of buildServicesFor(services, f.packageFile))
                            if (!existing.services.includes(s)) existing.services.push(s);
                        continue;
                    }
                    const ageDays =
                        typeof u.newVersionAgeInDays === 'number'
                            ? u.newVersionAgeInDays
                            : daysBetween(u.releaseTimestamp, new Date().toISOString());
                    const behindDays = daysBetween(dep.currentVersionTimestamp, u.releaseTimestamp);
                    const d = decidePolicy(cfg, {
                        kind,
                        name,
                        manager,
                        updateType,
                        newMajor: u.newMajor,
                        isBreaking: u.isBreaking,
                        inRange,
                        ageDays,
                        behindDays,
                    });
                    const held = inRange ? refreshHeld[f.packageFile.split('/')[0]] : undefined;
                    if (held && d.policy === 'silent') {
                        d.policy = 'ask';
                        d.reason = `the last refresh of these packages was rolled back: ${held}`;
                        d.waiting = false;
                    }
                    const svc =
                        isDocker && manager !== 'dockerfile'
                            ? servicesFor(services, name, dep.currentValue)
                            : {names: buildServicesFor(services, f.packageFile), owners: ['root']};
                    // A version step is known by the major line it starts from and where it goes, so a decision
                    // survives the pin changing shape underneath (a digest added, a moving tag made exact).
                    const byDigest = updateType === 'digest' || updateType === 'pinDigest';
                    const fromMajor = /\d+/.exec(String(dep.currentValue ?? ''))?.[0] ?? '';
                    const id = !isDocker
                        ? idOf(kind, name, current, target)
                        : byDigest
                          ? idOf(kind, name, current, target)
                          : idOf(
                                kind,
                                name,
                                fromMajor,
                                updateType === 'major' && u.newMajor !== undefined ? `major:${u.newMajor}` : newValue,
                            );
                    grouped.set(key, {
                        id,
                        kind,
                        name,
                        manager,
                        files: [f.packageFile],
                        current,
                        target,
                        updateType,
                        released: u.releaseTimestamp ?? null,
                        ageDays,
                        behindDays,
                        sourceUrl: dep.sourceUrl ?? dep.homepage ?? null,
                        services: svc.names,
                        owners: svc.owners,
                        policy: d.policy,
                        reason: d.reason,
                        edits: [],
                        places: place ? [place] : [],
                        state: d.waiting ? 'waiting' : 'pending',
                        ...(inRange ? {inRange} : {}),
                        ...(d.byRule ? {byRule: true} : {}),
                    });
                }
            }
        }
    }
    const list = [...grouped.values()].map(({manager: _m, ...item}) => item);
    for (const item of list) item.edits = editsFor(item, item.current, item.target ?? '');
    return {items: list.concat([...unpinned.values()]), pkgServices};
}

/**
 * A first pin takes the digest that runs now, not the registry's newest, so pinning changes no
 * bits. Where the tag moves between versions, the pin also writes the exact version from
 * `exactTags`.
 * @param {object} docker port with runningDigest(item) → digest | null
 */
export async function resolvePins(list, cfg, docker) {
    for (const item of list) {
        if (item.updateType !== 'pinDigest' || !item.target) continue;
        const registry = item.target.split('@')[1] ?? null;
        const running = await docker.runningDigest(item).catch(() => null);
        const digest = running ?? registry;
        if (!digest) continue;
        const target = versionOf(cfg.exactTags?.[`${item.name}:${item.current}`] ?? item.current, digest);
        if (target === item.target) continue;
        item.target = target;
        item.id = idOf(item.kind, item.name, item.current, target);
        item.edits = editsFor(item, item.current, target);
    }
}

/** A minor the assessor found clean, on something that keeps no data, held back by nothing but the default "ask". */
export function assessedClean(cfg, it) {
    return (
        Boolean(cfg.hooks?.assessor) &&
        it.assessment?.verdict === 'clean' &&
        it.updateType === 'minor' &&
        it.policy === 'ask' &&
        !it.byRule &&
        (it.kind === 'image' || it.kind === 'base-image') &&
        it.edits.length > 0 &&
        !it.services.some((s) => (cfg.hooks.assessorAskAnyway ?? []).includes(s))
    );
}

/** What was decided or done about findings before: dismissed, failed, forced, assessed; cooling-off by first sighting. */
export function applyPersisted(list, persisted, cfg, now = Date.now()) {
    for (const it of list) {
        if (it.policy === 'silent' && it.ageDays === null && it.updateType === 'patch') {
            persisted[it.id] = {
                ...persisted[it.id],
                firstSeen: persisted[it.id]?.firstSeen ?? new Date(now).toISOString(),
            };
            if (now - Date.parse(persisted[it.id].firstSeen) < cfg.minimumReleaseAgeDays * 86_400_000)
                it.state = 'waiting';
        }
        const p = persisted[it.id];
        if (!p) continue;
        if (p.dismissedUntil && Date.parse(p.dismissedUntil) > now) {
            it.state = 'dismissed';
            it.note = p.note;
            continue;
        }
        if (p.assessment) it.assessment = p.assessment;
        if (p.state === 'failed') {
            it.state = 'failed';
            it.policy = 'ask';
            it.reason = `was tried and rolled back: ${p.note ?? 'did not come up healthy'}`;
        } else if (p.state === 'applying' || p.state === 'verifying') {
            it.state = p.state;
        } else if (p.queued && it.policy !== 'silent') {
            it.policy = 'silent';
            it.reason = `a person asked for it to be tried at its own time. Before that: ${it.reason}`;
        } else if (assessedClean(cfg, it)) {
            it.policy = 'silent';
            it.reason = `minor step; the assessor read the release notes on ${p.assessment.at.slice(0, 10)} and found nothing that touches how it runs here: ${p.assessment.why ?? ''}`;
            if (it.ageDays !== null && it.ageDays < cfg.minimumReleaseAgeDays) it.state = 'waiting';
        }
    }
    return list;
}
