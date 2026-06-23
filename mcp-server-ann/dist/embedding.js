import crypto from 'crypto';
function hashEmbedding(text) {
    const hash = crypto.createHash('sha256').update(text).digest();
    const vec = [];
    for (let i = 0; i < 32; i++) {
        vec.push((hash[i] / 127.5) - 1.0);
    }
    return vec;
}
function normalizeVector(values, dimensions = 32) {
    const padded = values.slice(0, dimensions);
    while (padded.length < dimensions)
        padded.push(0);
    const magnitude = Math.sqrt(padded.reduce((sum, value) => sum + value * value, 0)) || 1;
    return padded.map(value => value / magnitude);
}
async function openAIEmbedding(text) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('ANN_EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY');
    }
    const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: process.env.ANN_EMBEDDING_MODEL || 'text-embedding-3-small',
            input: text
        })
    });
    if (!response.ok) {
        throw new Error(`OpenAI embedding request failed: ${response.status} ${await response.text()}`);
    }
    const json = await response.json();
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
        throw new Error('OpenAI embedding response did not include an embedding vector');
    }
    return normalizeVector(embedding);
}
export async function generateEmbedding(text) {
    const provider = (process.env.ANN_EMBEDDING_PROVIDER || 'hash').toLowerCase();
    if (provider === 'openai')
        return openAIEmbedding(text);
    if (provider === 'local') {
        // Reserved extension point for a local embedding sidecar; hash keeps ANN zero-config.
        return hashEmbedding(text);
    }
    return hashEmbedding(text);
}
