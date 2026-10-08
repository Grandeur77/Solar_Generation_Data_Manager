// Shared toJSON options: shows MongoDB's _id as the entity's own id field (e.g. province_id),
// first in the object, and drops Mongoose's internal __v version key.
function toJsonOptions(idField) {
  return {
    transform(doc, ret) {
      const { _id, __v, ...rest } = ret;
      return { [idField]: _id, ...rest };
    },
  };
}

module.exports = { toJsonOptions };
