import { parseQuoteId, validateQuoteInput } from '../dist/plugins/quotes/quote.js';
import { dataToString, dataToToken } from './helpers.js';

export function fuzz(data) {
    const input = dataToString(data);
    validateQuoteInput(input);
    parseQuoteId(dataToToken(data));
}
