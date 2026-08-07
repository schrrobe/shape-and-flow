import { Body, Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { registerOrganizationRequestSchema } from '@shape-and-flow/booking-contracts';

import { Public } from '../common/guards/public.decorator.js';
import { ENV } from '../config/env.schema.js';

import { OrganizationRegistrationService } from './organization-registration.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type { RegisterOrganizationResponse } from '@shape-and-flow/booking-contracts';
import type { CookieOptions, Response } from 'express';

/** `POST /public/organizations`. */
@Controller('public/organizations')
export class OrganizationRegistrationController {
  constructor(
    private readonly registrations: OrganizationRegistrationService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post()
  @HttpCode(201)
  async register(
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RegisterOrganizationResponse> {
    const body = registerOrganizationRequestSchema.parse(rawBody);
    const { response: result, sid } = await this.registrations.register(body);

    response.cookie(this.config.SESSION_COOKIE_NAME, sid, this.cookieOptions());
    return result;
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api',
    };
  }
}
