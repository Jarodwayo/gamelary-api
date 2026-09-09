import 'dotenv/config';

import app from './app.js';

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(`gamelary-api en écoute sur le port ${port}`);
});
