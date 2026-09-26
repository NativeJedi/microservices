import { Injectable } from '@nestjs/common';
import { NotifyEmailDto } from './dto/notify-email.dto';
import nodemailer, { Transporter } from 'nodemailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NotificationsService {
  private readonly transporter: Transporter;

  constructor(private readonly configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: this.configService.getOrThrow('SMTP_USER'),
        clientId: this.configService.getOrThrow('GOOGLE_OAUTH_CLIENT_ID'),
        clientSecret: this.configService.getOrThrow(
          'GOOGLE_OAUTH_CLIENT_SECRET',
        ),
        refreshToken: this.configService.getOrThrow(
          'GOOGLE_OAUTH_REFRESH_TOKEN',
        ),
      },
    });
  }

  async notifyEmail({ email, text }: NotifyEmailDto) {
    await this.transporter.sendMail({
      from: this.configService.getOrThrow('SMTP_USER'),
      to: email,
      subject: 'Sleepr Notification',
      text,
    });
  }

  onApplicationShutdown() {
    this.transporter.close();
  }
}
