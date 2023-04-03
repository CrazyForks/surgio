import { createLogger } from '@surgio/logger';
import _ from 'lodash';
import { ERR_INVALID_FILTER, OBFS_UA } from '../constant';
import {
  HttpNodeConfig,
  HttpsNodeConfig,
  NodeFilterType,
  NodeTypeEnum,
  PossibleNodeConfigType,
  ShadowsocksNodeConfig,
  ShadowsocksrNodeConfig,
  SnellNodeConfig,
  SortedNodeNameFilterType,
  VmessNodeConfig,
} from '../types';
import { isIp, pickAndFormatStringList } from './index';
import { applyFilter } from './filter';

const logger = createLogger({ service: 'surgio:utils:surge' });

export const getSurgeExtendHeaders = (
  wsHeaders: Record<string, string>,
): string => {
  return Object.keys(wsHeaders)
    .map((headerKey) => `${headerKey}:${wsHeaders[headerKey]}`)
    .join('|');
};

/**
 * @see https://manual.nssurge.com/policy/proxy.html
 */
export const getSurgeNodes = function (
  list: ReadonlyArray<PossibleNodeConfigType>,
  filter?: NodeFilterType | SortedNodeNameFilterType,
): string {
  // istanbul ignore next
  if (arguments.length === 2 && typeof filter === 'undefined') {
    throw new Error(ERR_INVALID_FILTER);
  }

  const result: string[] = applyFilter(list, filter)
    .map((nodeConfig): string | undefined => {
      switch (nodeConfig.type) {
        case NodeTypeEnum.Shadowsocks: {
          const config = nodeConfig as ShadowsocksNodeConfig;

          if (config.obfs && ['ws', 'wss'].includes(config.obfs)) {
            logger.warn(
              `不支持为 Surge 生成 v2ray-plugin 的 Shadowsocks 节点，节点 ${
                nodeConfig!.nodeName
              } 会被省略`,
            );
            return void 0;
          }

          return [
            config.nodeName,
            [
              'ss',
              config.hostname,
              config.port,
              'encrypt-method=' + config.method,
              ...pickAndFormatStringList(
                config,
                [
                  'password',
                  'udpRelay',
                  'obfs',
                  'obfsHost',
                  'tfo',
                  'mptcp',
                  'testUrl',
                  'underlyingProxy',
                ],
                {
                  keyFormat: 'kebabCase',
                },
              ),
              ...parseShadowTlsConfig(nodeConfig),
            ].join(', '),
          ].join(' = ');
        }

        case NodeTypeEnum.HTTPS: {
          const config = nodeConfig as HttpsNodeConfig;

          return [
            config.nodeName,
            [
              'https',
              config.hostname,
              config.port,
              config.username,
              config.password,
              ...pickAndFormatStringList(
                config,
                [
                  'sni',
                  'tfo',
                  'mptcp',
                  'tls13',
                  'testUrl',
                  'skipCertVerify',
                  'underlyingProxy',
                  'serverCertFingerprintSha256',
                ],
                {
                  keyFormat: 'kebabCase',
                },
              ),
              ...parseShadowTlsConfig(nodeConfig),
            ].join(', '),
          ].join(' = ');
        }

        case NodeTypeEnum.HTTP: {
          const config = nodeConfig as HttpNodeConfig;

          return [
            config.nodeName,
            [
              'http',
              config.hostname,
              config.port,
              config.username,
              config.password,
              ...pickAndFormatStringList(
                config,
                ['tfo', 'mptcp', 'underlyingProxy', 'testUrl'],
                {
                  keyFormat: 'kebabCase',
                },
              ),
              ...parseShadowTlsConfig(nodeConfig),
            ].join(', '),
          ].join(' = ');
        }

        case NodeTypeEnum.Snell: {
          const config = nodeConfig as SnellNodeConfig;

          return [
            config.nodeName,
            [
              'snell',
              config.hostname,
              config.port,
              ...pickAndFormatStringList(
                config,
                [
                  'psk',
                  'obfs',
                  'obfsHost',
                  'version',
                  'reuse',
                  'tfo',
                  'mptcp',
                  'testUrl',
                  'underlyingProxy',
                ],
                {
                  keyFormat: 'kebabCase',
                },
              ),
              ...parseShadowTlsConfig(nodeConfig),
            ].join(', '),
          ].join(' = ');
        }

        case NodeTypeEnum.Shadowsocksr: {
          const config = nodeConfig as ShadowsocksrNodeConfig;

          // istanbul ignore next
          if (!config.binPath) {
            throw new Error(
              '请按照文档 https://url.royli.dev/vdGh2 添加 Shadowsocksr 二进制文件路径',
            );
          }

          const args = [
            '-s',
            config.hostname,
            '-p',
            `${config.port}`,
            '-m',
            config.method,
            '-o',
            config.obfs,
            '-O',
            config.protocol,
            '-k',
            config.password,
            '-l',
            `${config.localPort}`,
            '-b',
            '127.0.0.1',
          ];

          if (config.protoparam) {
            args.push('-G', config.protoparam);
          }
          if (config.obfsparam) {
            args.push('-g', config.obfsparam);
          }

          const configString = [
            'external',
            `exec = ${JSON.stringify(config.binPath)}`,
            ...args.map((arg) => `args = ${JSON.stringify(arg)}`),
            `local-port = ${config.localPort}`,
          ];

          if (config.localPort === 0) {
            throw new Error(
              `为 Surge 生成 SSR 配置时必须为 Provider ${config.provider?.name} 设置 startPort，参考 https://url.royli.dev/bWcpe`,
            );
          }

          if (config.hostnameIp && config.hostnameIp.length) {
            configString.push(
              ...config.hostnameIp.map((item) => `addresses = ${item}`),
            );
          }

          if (isIp(config.hostname)) {
            configString.push(`addresses = ${config.hostname}`);
          }

          return [config.nodeName, configString.join(', ')].join(' = ');
        }

        case NodeTypeEnum.Vmess: {
          const config = nodeConfig as VmessNodeConfig;

          const configList = [
            'vmess',
            config.hostname,
            config.port,
            `username=${config.uuid}`,
          ];

          if (
            ['chacha20-ietf-poly1305', 'aes-128-gcm'].includes(config.method)
          ) {
            configList.push(`encrypt-method=${config.method}`);
          }

          if (config.network === 'ws') {
            configList.push('ws=true');
            configList.push(`ws-path=${config.path}`);
            configList.push(
              'ws-headers=' +
                JSON.stringify(
                  getSurgeExtendHeaders({
                    host: config.host || config.hostname,
                    'user-agent': OBFS_UA,
                    ..._.omit(config.wsHeaders, ['host']), // host 本质上是一个头信息，所以可能存在冲突的情况。以 host 属性为准。
                  }),
                ),
            );
          }

          if (config.tls) {
            configList.push(
              'tls=true',
              ...pickAndFormatStringList(
                config,
                ['tls13', 'skipCertVerify', 'serverCertFingerprintSha256'],
                {
                  keyFormat: 'kebabCase',
                },
              ),
              ...(config.host ? [`sni=${config.host}`] : []),
            );
          }

          configList.push(
            ...pickAndFormatStringList(
              config,
              ['tfo', 'mptcp', 'underlyingProxy', 'testUrl'],
              {
                keyFormat: 'kebabCase',
              },
            ),
          );

          if (nodeConfig?.surgeConfig?.vmessAEAD) {
            configList.push('vmess-aead=true');
          } else {
            configList.push('vmess-aead=false');
          }

          configList.push(...parseShadowTlsConfig(nodeConfig));

          return [config.nodeName, configList.join(', ')].join(' = ');
        }

        case NodeTypeEnum.Trojan: {
          const configList: string[] = [
            'trojan',
            nodeConfig.hostname,
            `${nodeConfig.port}`,
            `password=${nodeConfig.password}`,
            ...pickAndFormatStringList(
              nodeConfig,
              [
                'tfo',
                'mptcp',
                'sni',
                'tls13',
                'testUrl',
                'underlyingProxy',
                'skipCertVerify',
                'serverCertFingerprintSha256',
              ],
              {
                keyFormat: 'kebabCase',
              },
            ),
            ...parseShadowTlsConfig(nodeConfig),
          ];

          if (nodeConfig.network === 'ws') {
            configList.push('ws=true');
            configList.push(`ws-path=${nodeConfig.wsPath}`);

            if (nodeConfig.wsHeaders) {
              configList.push(
                'ws-headers=' +
                  JSON.stringify(getSurgeExtendHeaders(nodeConfig.wsHeaders)),
              );
            }
          }

          return [nodeConfig.nodeName, configList.join(', ')].join(' = ');
        }

        case NodeTypeEnum.Socks5: {
          const config = [
            nodeConfig.tls === true ? 'socks5-tls' : 'socks5',
            nodeConfig.hostname,
            nodeConfig.port,
            ...pickAndFormatStringList(
              nodeConfig,
              [
                'username',
                'password',
                'sni',
                'tfo',
                'mptcp',
                'tls13',
                'udpRelay',
                'testUrl',
                'underlyingProxy',
                'serverCertFingerprintSha256',
              ],
              {
                keyFormat: 'kebabCase',
              },
            ),
            ...parseShadowTlsConfig(nodeConfig),
          ];

          if (nodeConfig.tls === true) {
            config.push(
              ...(typeof nodeConfig.skipCertVerify === 'boolean'
                ? [`skip-cert-verify=${nodeConfig.skipCertVerify}`]
                : []),
              ...(typeof nodeConfig.clientCert === 'string'
                ? [`client-cert=${nodeConfig.clientCert}`]
                : []),
            );
          }

          return [nodeConfig.nodeName, config.join(', ')].join(' = ');
        }

        case NodeTypeEnum.Tuic: {
          const config = [
            'tuic',
            nodeConfig.hostname,
            nodeConfig.port,
            ...pickAndFormatStringList(
              nodeConfig,
              [
                'token',
                'sni',
                'underlyingProxy',
                'testUrl',
                'skipCertVerify',
                'serverCertFingerprintSha256',
              ],
              {
                keyFormat: 'kebabCase',
              },
            ),
            ...(Array.isArray(nodeConfig.alpn)
              ? [`alpn=${nodeConfig.alpn.join(',')}`]
              : []),
          ];

          return [nodeConfig.nodeName, config.join(', ')].join(' = ');
        }

        // istanbul ignore next
        default:
          logger.warn(
            `不支持为 Surge 生成 ${(nodeConfig as any).type} 的节点，节点 ${
              (nodeConfig as any).nodeName
            } 会被省略`,
          );
          return void 0;
      }
    })
    .filter((item): item is string => item !== undefined);

  return result.join('\n');
};

function parseShadowTlsConfig(config: PossibleNodeConfigType) {
  const result: string[] = [];

  if (config.shadowTls) {
    result.push(`shadow-tls-password=${config.shadowTls.password}`);

    if (config.shadowTls.sni) {
      result.push(`shadow-tls-sni=${config.shadowTls.sni}`);
    }
  }

  return result;
}