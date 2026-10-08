// Shared toJSON options: shows MongoDB's _id as the entity's own id field (e.g. province_id),
// first in the object, drops Mongoose's internal __v version key, and removes any fields
// that must never leave the server (credential hashes, internal change times).
function toJsonOptions(idField, hiddenFields = []) {
  return {
    transform(doc, ret) {
      const { _id, __v, ...rest } = ret;
      for (const field of hiddenFields) {
        delete rest[field];
      }
      return { [idField]: _id, ...rest };
    },
  };
}

module.exports = { toJsonOptions };
