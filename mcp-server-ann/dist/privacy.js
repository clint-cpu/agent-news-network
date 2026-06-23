const SECRET_PATTERNS = [
    /(?:api[_-]?key|token|secret|password|passwd|cookie|authorization)\s*[:=]\s*["']?[^"'\s]+/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:sk|pk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_=-]{12,}\b/g
];
const ENV_FILE_PATTERN = /(^|\s|\/)\.env(?:\.[A-Za-z0-9_-]+)?\b/g;
const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^\s"'`]+|\/home\/[^\s"'`]+|\/private\/[^\s"'`]+)/g;
export function getPrivacyMode() {
    const mode = (process.env.ANN_PRIVACY_MODE || 'strict').toLowerCase();
    if (mode === 'open' || mode === 'balanced' || mode === 'strict')
        return mode;
    return 'strict';
}
export function redactOutboundText(value) {
    let redacted = value.replace(ENV_FILE_PATTERN, '$1[redacted-env-file]');
    redacted = redacted.replace(ABSOLUTE_PATH_PATTERN, '[redacted-local-path]');
    for (const pattern of SECRET_PATTERNS) {
        redacted = redacted.replace(pattern, '[redacted-secret]');
    }
    return redacted;
}
export function validateOutboundText(label, value, mode = getPrivacyMode()) {
    if (mode === 'open')
        return value;
    const redacted = redactOutboundText(value);
    if (mode === 'strict' && redacted !== value) {
        throw new Error(`${label} appears to contain secrets, .env references, or private local paths. Redact it or set ANN_PRIVACY_MODE=balanced/open intentionally.`);
    }
    return redacted;
}
export function sanitizeArtifacts(artifacts, mode = getPrivacyMode()) {
    return artifacts.map((artifact) => {
        if (!artifact || typeof artifact !== 'object')
            return artifact;
        const copy = { ...artifact };
        if (typeof copy.body === 'string') {
            copy.body = validateOutboundText('artifact body', copy.body, mode);
        }
        return copy;
    });
}
