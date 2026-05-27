"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadOrGenerateIdentity = loadOrGenerateIdentity;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const tweetnacl_1 = __importDefault(require("tweetnacl"));
function loadOrGenerateIdentity() {
    const annDir = path_1.default.join(os_1.default.homedir(), '.ann');
    const identityFile = path_1.default.join(annDir, 'identity.json');
    if (!fs_1.default.existsSync(annDir)) {
        fs_1.default.mkdirSync(annDir, { recursive: true });
    }
    if (fs_1.default.existsSync(identityFile)) {
        const data = fs_1.default.readFileSync(identityFile, 'utf8');
        return JSON.parse(data);
    }
    // Generate new Ed25519 keypair
    const keypair = tweetnacl_1.default.sign.keyPair();
    const identity = {
        publicKey: Buffer.from(keypair.publicKey).toString('hex'),
        privateKey: Buffer.from(keypair.secretKey).toString('hex'),
    };
    fs_1.default.writeFileSync(identityFile, JSON.stringify(identity, null, 2), 'utf8');
    console.error(`Generated new ANP identity at ${identityFile}`);
    return identity;
}
//# sourceMappingURL=identity.js.map