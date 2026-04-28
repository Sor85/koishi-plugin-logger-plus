/**
 * Vite YAML 导入插件
 * 将 yml/yaml 文件编译为默认导出的对象
 */
import type { Plugin } from 'vite'
import { readFileSync } from 'fs'
import YAML from 'yaml'

export default function yaml(): Plugin {
  return {
    name: 'logger-plus-yaml',
    transform(code, id) {
      if (!/\.ya?ml$/.test(id)) return
      const content = code || readFileSync(id, 'utf8')
      return {
        code: `export default ${JSON.stringify(YAML.parse(content))}`,
        map: null,
      }
    },
  }
}
