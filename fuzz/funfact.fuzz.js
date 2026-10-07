import { parseFactId, validateFactText } from '../dist/plugins/funfact/fact.js';
import { dataToString, dataToToken } from './helpers.js';

export function fuzz(data) {
    const input = dataToString(data);
    validateFactText(input);
    parseFactId(dataToToken(data));
}
