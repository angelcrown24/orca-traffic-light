import { env } from 'orca'
import { panelLanguage } from './panel-language'

export const ko = () => panelLanguage(env.locale) === 'ko'
export const say = (en: string, kr: string) => ko() ? kr : en
export const providers = (names: string[]) => names.map(n => ko() && n === 'Shared' ? '공용' : n).join(' · ')

export function displayPath(path: string) {
  return /^(?:~[/\\]|[/\\]|[a-z]:[/\\])/i.test(path) ? path : '~/' + path
}
export function instructionFile(root: string) {
  const separator = root.includes('\\') ? '\\' : '/'
  return root.endsWith(separator + 'SKILL.md') ? root : root.replace(/[/\\]$/, '') + separator + 'SKILL.md'
}
export function blockedReason(code: string, editing: boolean) {
  switch (code) {
    case 'protected-root': return say('This installation is outside the editable skill folders.', '이 설치본은 수정할 수 있는 스킬 폴더 밖에 있습니다.')
    case 'nested-installation': return say('Removing this folder would also remove another installed skill. Review that installation separately.', '이 폴더를 삭제하면 안에 설치된 다른 스킬도 영향을 받습니다. 해당 설치본을 별도로 점검하세요.')
    case 'managed-snapshot': return editing ? say('This is a managed shared snapshot. Edit its original, then update it in Library.', '관리 중인 공용 스냅샷입니다. 원본을 수정한 뒤 공용 도구에서 업데이트하세요.') : say('The shared registry references this installation. Removing it here would break its published copy.', '공용 보관함이 이 설치본을 참조합니다. 삭제하면 배포된 공용본의 연결이 끊어집니다.')
    case 'inventory-incomplete': return say('Some linked installations could not be checked. Refresh the review after they are accessible.', '일부 연결된 설치본을 확인하지 못했습니다. 해당 위치에 접근할 수 있을 때 다시 점검하세요.')
    case 'changed': case 'stale': return say('The installation changed. Check it again before continuing.', '설치본이 바뀌었습니다. 다시 점검한 뒤 진행하세요.')
    case 'unsupported-package': return say('This package contains unsupported files or exceeds the size limit.', '지원하지 않는 파일이 있거나 패키지 크기 한도를 넘습니다.')
    case 'unreadable': return say('The instruction file could not be read. Check local access permissions.', '지침 파일을 읽을 수 없습니다. 파일의 접근 권한을 확인하세요.')
    default: return say('This package layout cannot be changed here.', '이 설치 구조는 패널에서 변경할 수 없습니다.')
  }
}
