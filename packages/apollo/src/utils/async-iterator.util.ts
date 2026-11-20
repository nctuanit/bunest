export type AsyncIteratorLike<T> = AsyncIterableIterator<T>;

export const createAsyncIterator = async <T = any>(
  lazyFactory: Promise<AsyncIterator<T>> | AsyncIterator<T>,
  filterFn: (payload: T) => boolean | Promise<boolean>,
): Promise<AsyncIterableIterator<T>> => {
  const asyncIterator = await lazyFactory;

  const getNextValue = (): Promise<IteratorResult<T>> => {
    return new Promise((resolve, reject) => {
      const inner = () => {
        if (!asyncIterator || typeof asyncIterator.next !== "function") {
          reject(asyncIterator);
          return;
        }
        asyncIterator
          .next()
          .then((payload) => {
            if (payload.done === true) {
              resolve(payload);
              return;
            }
            Promise.resolve()
              .then(() => filterFn(payload.value))
              .catch(() => false)
              .then((result) => {
                if (result === true) {
                  resolve(payload);
                  return;
                }
                inner();
              });
          })
          .catch(reject);
      };
      inner();
    });
  };

  const iterator: AsyncIterableIterator<T> = {
    next() {
      return getNextValue();
    },
    return() {
      const hasReturn =
        asyncIterator && typeof asyncIterator.return === "function";
      return hasReturn
        ? asyncIterator.return!()
        : Promise.resolve({
            done: true as const,
            value: undefined,
          });
    },
    throw(error?: any) {
      if (asyncIterator && typeof asyncIterator.throw === "function") {
        return asyncIterator.throw(error);
      }
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return iterator;
};
