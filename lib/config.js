/**
 * The configuration: `stacktender.yaml` in the stack's repository, merged over these defaults.
 * Every key is documented in the README; the defaults are the safe side (autopilot off).
 */

export const DEFAULTS = {
    /** Apply the routine updates by itself; false: everything becomes a proposal. */
    autopilot: false,
    /** IANA time zone the windows and the nightly time are read in. */
    tz: 'UTC',
    scanIntervalHours: 6,
    applyWindow: {from: '10:00', to: '17:00'},
    infraWindow: {from: '02:00', to: '05:00'},
    /** Compose services everything else depends on: only restarted inside infraWindow. */
    infraServices: [],
    /** Minutes between two applies. */
    minGapMinutes: 30,
    soakMinutes: 5,
    deployTimeoutMinutes: 15,
    /** A release younger than this waits. */
    minimumReleaseAgeDays: 3,
    /** Longer behind than this: a person decides. */
    maxCatchUpDays: 60,
    /** Proposals are batched: at most one batch per this many hours. */
    announceIntervalHours: 20,
    /** Pin images to the digest they run on and follow upstream rebuilds of the same tag. */
    digests: true,
    /** At most one rebuild of the same tag per image in this many days. */
    digestIntervalDays: 7,
    /** Moving tags replaced by the exact version when first pinned: {"redis:7-alpine": "7.4.8-alpine"}. */
    exactTags: {},
    /** Policy rules: [{match, manager, updateTypes, policy, why}], the first that covers a finding wins. */
    rules: [],
    /** The service stacktender itself runs as, when it is part of the stack: judged by what joins the unhealthy list, not by itself. */
    selfService: 'stacktender',
    hooks: {
        /** POST before a minor or major step is proposed; answers {verdict, why}. */
        assessor: null,
        /** Services a person decides about even on a clean verdict. */
        assessorAskAnyway: [],
        /** POST at the end of the soak; answers {ok, why}. */
        veto: null,
        timeoutSeconds: 30,
    },
    backups: {
        /** Nightly runs. Off: snapshots and restores on request still work. */
        on: true,
        at: '01:00',
        /** The restic repository as a compose bind source (outside the stack directory) or a restic URL. */
        repository: '../stacktender-backups',
        image: 'restic/restic:0.18.1',
        /** Repo-relative directories never copied. */
        exclude: [],
        /** Repo-relative paths that are data although git tracks them, or that no service mounts. */
        data: ['.env'],
        /** Services never stopped for a copy; their directories are copied live. */
        noStop: [],
        keepWithin: '14d',
        keepWeekly: 8,
        /** Weekday of the repository check (0 = Sunday). */
        checkWeekday: 0,
        staleHours: 36,
        minFreeGb: 10,
        stopTimeoutSeconds: 30,
        jobTimeoutMinutes: 30,
        /** The host name the snapshots carry; restic groups retention by it. Keep it when moving an existing repository in. */
        host: 'stack',
        /** uid:gid the restic runner runs as; root by default, since the data directories belong to the services' own users. */
        user: null,
    },
    host: {
        report: false,
        pendingDays: 3,
        staleDays: 3,
        rebootDays: 7,
        diskAskPercent: 80,
        diskErrorPercent: 90,
    },
    housekeeping: {
        on: true,
        intervalDays: 7,
        keepDays: 14,
    },
    deploy: {
        /** A command that must exit 0 before anything is reloaded or recreated. */
        test: null,
        /** Bring your own deploy: a command run with the old and new commit; the shipped one when null. */
        command: null,
    },
    notify: {
        webhooks: [],
        /** {url, username, password, maintenanceTopic, eventsTopic, stateTopic, name}: the maintenance signal per source retained on <maintenanceTopic>/<name>-<source>, events on <eventsTopic>. */
        mqtt: null,
    },
};

/** Deep-ish merge: one level of nesting (the sections), arrays and scalars replaced. */
export function mergeConfig(given = {}) {
    const out = {...DEFAULTS, ...given};
    for (const key of Object.keys(DEFAULTS)) {
        const d = DEFAULTS[key];
        if (d && typeof d === 'object' && !Array.isArray(d) && given[key] && typeof given[key] === 'object') {
            out[key] = {...d, ...given[key]};
        }
    }
    return out;
}
