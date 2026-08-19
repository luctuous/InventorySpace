import { OpenAPIHono } from '@hono/zod-openapi';
import { errorBody } from '../middleware/error';

// Every sub-router is an OpenAPIHono created through this factory so
// validation failures share the uniform error shape. The Env type parameter
// lets guarded routers declare what their middleware puts in the context
// (e.g. AuthEnv → c.get('user')).
export function createRouter<E extends { Variables: object } = { Variables: object }>() {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          errorBody('validation_error', 'Invalid request', result.error.issues),
          400,
        );
      }
    },
  });
}
