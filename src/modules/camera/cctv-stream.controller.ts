import {
  BadGatewayException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { AllConfigType } from '@/config/config.type';
import { Public } from '@/common/decorators/public.decorator';
import { CctvStreamTokenService } from './cctv-stream-token.service';
import {
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
} from './hls-playlist.rewriter';
import { CameraRepository } from './infrastructure/persistence/camera.repository';
import { MediaGatewayPort } from './media-gateway.port';

const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
/** Gateway session ids are short opaque strings; anything else is not ours. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The streaming door. Unauthenticated in the session sense — the signed token
 * in `t` IS the credential, because a video player cannot carry our bearer
 * header through playlist and segment requests.
 *
 * Only playlists pass through here. Segments are served by the edge proxy
 * straight from the media gateway after it calls `/cctv/validate`, so the
 * bytes never travel through Node. Playlists cannot take that route: the
 * gateway emits its own relative URIs, which have to be rewritten onto our
 * origin with the token attached.
 *
 * Excluded from Swagger deliberately — these are machine endpoints for the
 * player and the proxy, not part of the app-facing contract.
 */
@ApiExcludeController()
@Controller({ path: 'cctv', version: '1' })
export class CctvStreamController {
  constructor(
    private readonly tokens: CctvStreamTokenService,
    private readonly cameras: CameraRepository,
    @Inject(MediaGatewayPort) private readonly gateway: MediaGatewayPort,
    private readonly config: ConfigService<AllConfigType>,
  ) {}

  @Public()
  @Get('hls/:cameraId/index.m3u8')
  @Header('content-type', PLAYLIST_CONTENT_TYPE)
  @Header('cache-control', 'no-store')
  async master(
    @Param('cameraId', new ParseUUIDPipe()) cameraId: string,
    @Query('t') token?: string,
  ): Promise<string> {
    const claims = this.tokens.verify(token);
    // The token names the camera it was issued for. Without this check a
    // token for one camera would open every camera in the system.
    if (!claims || claims.cameraId !== cameraId) {
      throw new ForbiddenException('cctv_token_invalid');
    }

    const camera = await this.cameras.findByIdCrossTenant(cameraId);
    if (!camera || !camera.isStreamable || !camera.streamKey) {
      throw new NotFoundException('camera_not_found');
    }

    const body = await this.gateway.masterPlaylist(camera.streamKey);
    if (!body) throw new BadGatewayException('cctv_gateway_unavailable');

    const rewritten = rewriteMasterPlaylist(body, {
      publicBase: this.publicBase(),
      token: token as string,
    });
    if (!rewritten) throw new BadGatewayException('cctv_playlist_unreadable');
    return rewritten;
  }

  @Public()
  @Get('hls/media.m3u8')
  @Header('content-type', PLAYLIST_CONTENT_TYPE)
  @Header('cache-control', 'no-store')
  async media(
    @Query('id') sessionId?: string,
    @Query('t') token?: string,
  ): Promise<string> {
    const claims = this.tokens.verify(token);
    if (!claims) throw new ForbiddenException('cctv_token_invalid');
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new NotFoundException('cctv_session_not_found');
    }

    // The session id is not bound to the camera in the token: it is a random
    // handle the gateway minted a moment ago, and it only ever reaches a
    // client through `master()` above, which did check the binding. Guessing
    // one is the attack this relies on being impractical.
    const body = await this.gateway.mediaPlaylist(sessionId);
    if (!body) throw new NotFoundException('cctv_session_not_found');

    const rewritten = rewriteMediaPlaylist(body, {
      publicBase: this.publicBase(),
      token: token as string,
    });
    if (!rewritten) throw new BadGatewayException('cctv_playlist_unreadable');
    return rewritten;
  }

  /**
   * Called by the edge proxy for every segment request (`forward_auth`), which
   * is why it does nothing but check a signature: no database, no Redis, no
   * gateway call. 200 lets the proxy serve the bytes, 403 stops it.
   */
  @Public()
  @Get('validate')
  @Header('cache-control', 'no-store')
  validate(@Query('t') token?: string): { ok: true } {
    if (!this.tokens.verify(token)) {
      throw new ForbiddenException('cctv_token_invalid');
    }
    return { ok: true };
  }

  private publicBase(): string {
    const base = this.config.get('cctv.streamPublicBase', { infer: true });
    if (!base) throw new BadGatewayException('cctv_not_configured');
    return base;
  }
}
