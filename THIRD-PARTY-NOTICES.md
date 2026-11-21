# Third-party notices

## Pi (`@earendil-works/pi-ai` 1.5.0)

The retry and overflow pattern tables in `shell/src/state/retry.ts` are ported
from Pi 1.5.0 (`dist/utils/retry.js`, `dist/utils/overflow.js`).

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Embedding model (`Xenova/bge-base-zh-v1.5`)

- Upstream model: `BAAI/bge-base-zh-v1.5`, MIT License —
  https://huggingface.co/BAAI/bge-base-zh-v1.5. The model card declares
  `license: mit` and its License section names the MIT License.
- ONNX conversion used at runtime: `Xenova/bge-base-zh-v1.5` —
  https://huggingface.co/Xenova/bge-base-zh-v1.5. Its card declares
  `BAAI/bge-base-zh-v1.5` as the base model.
- Distribution: the weights are not vendored in this repository or the npm
  package. They are downloaded from Hugging Face at install or first start into
  `<dataDir>/models/` (`shell/src/embedding/worker.ts`,
  `shell/src/embedding/model.ts`), so this repository redistributes no model
  weights or model license text.
