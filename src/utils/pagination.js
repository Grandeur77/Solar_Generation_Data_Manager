const { ApiError } = require('./errors');

const DEFAULT_PAGE_SIZE = 50;
// Without a cap, page-size=100000 would turn a paged collection back into "send everything".
const MAX_PAGE_SIZE = 100;

const detail = (field, issue) => ({ field, location: 'query', issue, reference: null });

// One query value as a whole number in [min, max]; undefined when absent.
function wholeNumber(query, name, min, max, problems) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value) || Number(value) < min || Number(value) > max) {
    problems.push(detail(name, max === Infinity ? `Must be a whole number, ${min} or more, given once.` : `Must be a whole number from ${min} to ${max}, given once.`));
    return undefined;
  }
  return Number(value);
}

// Reads ?page= and ?page-size=, adding any problem to `problems` so a route can report every
// bad query value in one 400. Out-of-range values are never silently clamped.
function readPagination(query, problems) {
  const page = wholeNumber(query, 'page', 1, Infinity, problems);
  const pageSize = wholeNumber(query, 'page-size', 1, MAX_PAGE_SIZE, problems);
  return { page: page || 1, pageSize: pageSize || DEFAULT_PAGE_SIZE };
}

// The same, throwing the 400 itself, for routes whose only query values are the page ones.
function parsePagination(query) {
  const problems = [];
  const values = readPagination(query, problems);
  if (problems.length > 0) {
    throw new ApiError(400, 'INVALID_QUERY_PARAMETER', 'The pagination parameters are invalid.', problems);
  }
  return values;
}

// The page object from the 2.5 contract. `active` lists every other query parameter in effect
// (sort, filters) as [name, value] pairs, in a fixed order, so links never change what is paged
// and each page has exactly one URL. Links are relative, like Location headers.
function pageBody({ path, page, pageSize, count, results, active }) {
  const lastPage = Math.ceil(count / pageSize); // 0 when there is nothing at all
  const link = (p) => {
    const params = new URLSearchParams([['page', String(p)], ['page-size', String(pageSize)], ...active]);
    return `${path}?${params.toString()}`;
  };

  const next = page < lastPage ? link(page + 1) : null;
  let previous = null;
  if (page > 1 && lastPage > 0) {
    // Past the end, "previous" leads back to the last page that has items.
    previous = link(Math.min(page - 1, lastPage));
  }
  return { count, next, previous, results };
}

module.exports = { readPagination, parsePagination, pageBody, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
