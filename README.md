# Move Typescript

## Install

```sh
yarn add movets

# or

npm install movets --save
```

## Get Started

### Move File
```ts
import move from 'movets';

move(
  '/home/projects/hello-world', // route
  'src/utils.ts', // source
  'src/utils/index.ts' // target
);
```

### Move Folder
```ts
import move from 'movets';

move(
  '/home/projects/hello-world', // route
  'src/utils', // source
  'src/helpers/utils' // target
);
```

